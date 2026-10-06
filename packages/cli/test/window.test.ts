import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"

test("the CLI scopes its API to each invocation and never replaces another window", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-cli-window-"))
  const database = path.join(directory, "sessions.db")
  const children: ReturnType<typeof Bun.spawn>[] = []
  const errors: Promise<string>[] = []
  const start = async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixture/window.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        MIAO_DB: database,
        MIAO_TEST_HOME: directory,
        MIAO_PURE: "1",
        MIAO_DISABLE_MODELS_FETCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    errors.push(new Response(child.stderr).text())
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    while (!output.includes("\n")) {
      const part = await reader.read()
      if (part.done) throw new Error("CLI fixture exited before readiness")
      output += decoder.decode(part.value, { stream: true })
    }
    reader.releaseLock()
    const transport = JSON.parse(output.split("\n")[0]) as { url: string; headers: Record<string, string> }
    return { child, transport }
  }
  try {
    const first = await start()
    const second = await start()
    expect(second.transport.url).not.toBe(first.transport.url)
    expect(second.transport.headers).not.toEqual(first.transport.headers)
    first.child.kill(process.platform === "win32" ? "SIGTERM" : "SIGHUP")
    await first.child.exited
    await expect(fetch(first.transport.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    expect(
      (await fetch(new URL("/api/health", second.transport.url), { headers: second.transport.headers })).status,
    ).toBe(200)
    second.child.kill("SIGTERM")
    await second.child.exited
    const owner = await RuntimeOwnership.acquire(database)
    owner.release()
    expect((await Promise.all(errors)).join("")).not.toContain("ManagedRuntime disposed")
  } finally {
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGKILL")
    })
    await Promise.all(children.map((child) => child.exited))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
