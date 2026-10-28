import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// A crash record is only useful if it survives the process, so exercise it in a
// child with an isolated data dir: the parent cannot observe the file otherwise.
test("an uncaught error is recorded to crash.log", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-crash-"))
  const script = path.join(root, "record.ts")
  await Bun.write(
    script,
    `
import { Crash } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/crash.ts", import.meta.url)))}
Crash.recordCrash("uncaughtException", new Error("boom-42"))
Crash.recordCrash("unhandledRejection", { name: "Opaque", message: "no stack" })
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toContain("boom-42")

  const lines = (await Bun.file(path.join(root, "data", "miao", "log", "crash.log")).text()).trim().split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain("uncaughtException")
  expect(lines[0]).toContain("thread=main")
  expect(lines[0]).toContain("boom-42")
  expect(lines[1]).toContain("unhandledRejection")
  expect(lines[1]).toContain("no stack")
})

// The policy claim only holds if the runtime honors it: install the handlers
// in real child processes and observe the exit codes.
test("an unhandled rejection is recorded and the process keeps running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-crash-"))
  const script = path.join(root, "reject.ts")
  await Bun.write(
    script,
    `
import { Crash } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/crash.ts", import.meta.url)))}
Crash.installFatalHandlers()
Promise.reject(new Error("stray-43"))
setTimeout(() => process.stdout.write("still-alive"), 250)
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).toBe(0)
  expect(stdout).toContain("still-alive")
  expect(stderr).toContain("unhandledRejection")
  expect(await Bun.file(path.join(root, "data", "miao", "log", "crash.log")).text()).toContain("stray-43")
})

// A terminal that goes away, or a reader that stops reading, fails the write
// after `write()` returned. Bun delivers that as an uncaught exception even
// though every caller wrapped the call in try/catch, and exiting there would
// kill a Session mid-turn over a closed window.
test("a write to a closed stream is not fatal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-crash-"))
  const script = path.join(root, "closed-stream.ts")
  await Bun.write(
    script,
    `
import { Crash } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/crash.ts", import.meta.url)))}
Crash.installFatalHandlers()
await Bun.sleep(250)
process.stdout.write("goodbye")
await Bun.sleep(250)
process.stderr.write("still-alive")
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  // Cancelling the reader closes the read end, so the child's write fails the
  // way it does when a terminal window is torn down under a running TUI.
  await child.stdout.getReader().cancel()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toContain("still-alive")
  expect(stderr).not.toContain("uncaughtException")
  expect(await Bun.file(path.join(root, "data", "miao", "log", "crash.log")).exists()).toBe(false)
})

test("an uncaught exception still exits non-zero", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miao-crash-"))
  const script = path.join(root, "throw.ts")
  await Bun.write(
    script,
    `
import { Crash } from ${JSON.stringify(fileURLToPath(new URL("../../src/cli/crash.ts", import.meta.url)))}
Crash.installFatalHandlers()
setTimeout(() => {
  throw new Error("fatal-44")
}, 10)
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data") },
    stdout: "pipe",
    stderr: "pipe",
  })
  await new Response(child.stderr).text()
  expect(await child.exited).toBe(1)
  expect(await Bun.file(path.join(root, "data", "miao", "log", "crash.log")).text()).toContain("fatal-44")
})
