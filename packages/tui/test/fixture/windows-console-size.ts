import assert from "node:assert/strict"
import { closeSync, openSync } from "node:fs"
import { dlopen, ptr } from "bun:ffi"
import { win32ConsoleSize } from "../../src/terminal-win32"

const kernel = dlopen("kernel32.dll", {
  AllocConsole: { args: [], returns: "i32" },
  FreeConsole: { args: [], returns: "i32" },
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  SetStdHandle: { args: ["i32", "ptr"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "ptr" },
  SetConsoleScreenBufferSize: { args: ["ptr", "u32"], returns: "i32" },
  SetConsoleWindowInfo: { args: ["ptr", "i32", "ptr"], returns: "i32" },
})

if (!process.argv.includes("--console-child")) {
  // The launcher owns a private console. Pass its real input descriptor as
  // child stdin: the child is attached to that console and must be able to read
  // its window size without touching the terminal running the test.
  const output = kernel.symbols.GetStdHandle(-11)
  const error = kernel.symbols.GetStdHandle(-12)
  kernel.symbols.FreeConsole()
  assert.equal(kernel.symbols.AllocConsole(), 1)
  kernel.symbols.SetStdHandle(-11, output)
  kernel.symbols.SetStdHandle(-12, error)
  const input = openSync("CONIN$", "r+")
  try {
    const child = Bun.spawn([process.execPath, import.meta.filename, "--console-child"], {
      stdin: input,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    process.exitCode = code
  } finally {
    closeSync(input)
    kernel.symbols.FreeConsole()
    kernel.close()
  }
} else {
  // Redirect the Win32 output handle to the console while the process's own
  // stdout stays the pipe the launcher reads.
  const consoleOut = kernel.symbols.CreateFileW(
    Buffer.from("CONOUT$\0", "utf16le"),
    0x80000000 | 0x40000000,
    3,
    null,
    3,
    0,
    null,
  )
  assert.ok(consoleOut, "CONOUT$ must open on the inherited console")
  assert.equal(kernel.symbols.SetStdHandle(-11, consoleOut), 1)
  try {
    const window = (columns: number, rows: number) => {
      const rect = new Int16Array([0, 0, columns - 1, rows - 1])
      assert.equal(kernel.symbols.SetConsoleWindowInfo(consoleOut, 1, ptr(rect)), 1)
    }

    // Two different sizes, each smaller than the screen buffer, so the size the
    // helper reports can only come from the window rect and not from the buffer.
    assert.equal(kernel.symbols.SetConsoleScreenBufferSize(consoleOut, 200 | (80 << 16)), 1)
    window(100, 30)
    assert.deepEqual(win32ConsoleSize(), { columns: 100, rows: 30 })

    window(120, 50)
    assert.deepEqual(win32ConsoleSize(), { columns: 120, rows: 50 })

    console.log("WINDOWS_CONSOLE_SIZE_VERIFIED")
  } finally {
    kernel.close()
  }
}
