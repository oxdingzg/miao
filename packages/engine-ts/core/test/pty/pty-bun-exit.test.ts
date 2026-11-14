import { expect, test } from "bun:test"
import { spawn } from "../../src/pty/pty.bun"

const it = process.platform === "win32" ? test.skip : test

it("replays a real PTY exit to a late subscriber", async () => {
  const proc = spawn("/usr/bin/env", ["sh", "-c", "exit 4"], { name: "xterm" })
  try {
    // Establish that the child has been reaped before subscribing. This makes
    // the lost-notification case deterministic, rather than racing a fast exit.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const alive = (() => {
        try {
          process.kill(proc.pid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (!alive) break
      await Bun.sleep(10)
    }
    expect(() => process.kill(proc.pid, 0)).toThrow()
    const exits: number[] = []
    const listener = proc.onExit((event) => exits.push(event.exitCode))
    await Bun.sleep(20)
    expect(exits).toEqual([4])
    proc.kill()
    await Bun.sleep(20)
    expect(exits).toEqual([4])
    listener.dispose()
  } finally {
    proc.kill()
  }
})

it("disposes a queued late exit notification", async () => {
  const proc = spawn("/usr/bin/env", ["sh", "-c", "exit 0"], { name: "xterm" })
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const alive = (() => {
        try {
          process.kill(proc.pid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (!alive) break
      await Bun.sleep(10)
    }
    expect(() => process.kill(proc.pid, 0)).toThrow()
    const exits: number[] = []
    const listener = proc.onExit((event) => exits.push(event.exitCode))
    listener.dispose()
    await Bun.sleep(20)
    expect(exits).toEqual([])
  } finally {
    proc.kill()
  }
})
