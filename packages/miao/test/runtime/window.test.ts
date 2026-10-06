import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { readWindow } from "../fixture/window-runtime"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"

for (const signal of process.platform === "win32"
  ? (["stdin", "SIGTERM"] as const)
  : (["stdin", "SIGTERM", "SIGHUP"] as const)) {
  test(`a window stops its listener and releases storage on ${signal}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-window-"))
    const database = path.join(directory, "sessions.db")
    const child = Bun.spawn(
      [process.execPath, "run", "test/runtime/fixture-host.ts", ...(signal === "stdin" ? ["--close-on-eof"] : [])],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          MIAO_DB: database,
          MIAO_PURE: "1",
          MIAO_CONFIG_CONTENT: "{}",
          MIAO_TEST_HOME: directory,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      const deadline = Date.now() + 20_000
      let record = await readWindow(database)
      while (!record && Date.now() < deadline && child.exitCode === null) {
        await Bun.sleep(50)
        record = await readWindow(database)
      }
      if (!record) throw new Error("Window did not start")
      if (signal === "stdin") child.stdin.end()
      if (signal !== "stdin") child.kill(signal)
      await child.exited
      expect(await errors).toBe("")
      // Windows SIGTERM is forced process termination; it cannot run finally.
      if (process.platform !== "win32" || signal === "stdin")
        expect((await readWindow(database)) === undefined).toBe(true)
      await expect(fetch(record.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      const owner = await RuntimeOwnership.acquire(database)
      owner.release()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await Promise.all([output, errors])
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}

test(
  "ACP EOF ends its local runtime and releases storage",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-acp-window-"))
    const database = path.join(directory, "sessions.db")
    const child = Bun.spawn([process.execPath, "run", "src/index.ts", "acp"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, MIAO_DB: database, MIAO_PURE: "1", MIAO_CONFIG_CONTENT: "{}", MIAO_TEST_HOME: directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const deadline = Date.now() + (process.platform === "win32" ? 60_000 : 20_000)
      let record = await readWindow(database)
      while (!record && Date.now() < deadline && child.exitCode === null) {
        await Bun.sleep(50)
        record = await readWindow(database)
      }
      if (!record) throw new Error("ACP runtime did not start")
      const closedAt = Date.now()
      child.stdin.end()
      const result = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(Date.now() - closedAt).toBeLessThan(10_000)
      expect(result[0]).toBe(0)
      expect(result[2]).not.toContain("ManagedRuntime disposed")
      expect((await readWindow(database)) === undefined).toBe(true)
      const owner = await RuntimeOwnership.acquire(database)
      owner.release()
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  },
  process.platform === "win32" ? 90_000 : 30_000,
)
