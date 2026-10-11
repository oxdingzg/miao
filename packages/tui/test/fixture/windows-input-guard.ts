import assert from "node:assert/strict"
import { closeSync, openSync } from "node:fs"
import { dlopen, ptr } from "bun:ffi"
import { win32InstallCtrlCGuard } from "../../src/terminal-win32"

const kernel = dlopen("kernel32.dll", {
  AllocConsole: { args: [], returns: "i32" },
  FreeConsole: { args: [], returns: "i32" },
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  SetStdHandle: { args: ["i32", "ptr"], returns: "i32" },
  GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
  SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
})

if (!process.argv.includes("--console-child")) {
  // The launcher owns a private console. Pass its real input descriptor as
  // child stdin: Bun's raw-mode implementation requires the actual stdin TTY.
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
  assert.equal(process.stdin.isTTY, true)
  const handle = kernel.symbols.GetStdHandle(-10)
  const buffer = new Uint32Array(1)
  const readMode = () => {
    assert.equal(kernel.symbols.GetConsoleMode(handle, ptr(buffer)), 1)
    return buffer[0]!
  }
  const setMode = (mode: number) => assert.equal(kernel.symbols.SetConsoleMode(handle, mode), 1)
  const initial = readMode() | 7
  setMode(initial)
  const original = process.stdin.setRawMode
  const release = win32InstallCtrlCGuard()
  assert.equal(typeof release, "function")
  try {
    process.stdin.setRawMode(true)
    const raw = readMode()
    // Reproduce a child/runtime restoring cooked echo while the TUI is active.
    setMode(raw | 7)
    await Bun.sleep(180)
    assert.equal(readMode() & 7, 0, "raw input must not echo or line-buffer SGR mouse reports")
    assert.equal(readMode() & ~7, raw & ~7, "unrelated console flags must survive")
    process.stdin.setRawMode(false)
    setMode(readMode() | 7)
    await Bun.sleep(180)
    assert.equal(readMode() & 7, 6, "cooked handoff must retain echo and line input")
    process.stdin.setRawMode(true)
    // Release with a next-tick enforcement still pending.
    release!()
    await Bun.sleep(20)
    assert.equal(readMode(), initial, "release must restore the initial console mode")
    assert.equal(process.stdin.setRawMode, original, "release must restore the original raw-mode method")
    release!()
    console.log("WINDOWS_INPUT_GUARD_VERIFIED")
  } finally {
    release?.()
    kernel.close()
  }
}
