import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RuntimeOwnership } from "../src/runtime/ownership"

const directories: string[] = []
const owners: RuntimeOwnership.Owner[] = []
afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.release())
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function storage() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-runtime-owner-"))
  directories.push(directory)
  return path.join(await realpath(directory), "session.db")
}
async function acquire(filename: string) {
  const owner = await RuntimeOwnership.acquire(filename)
  owners.push(owner)
  return owner
}

describe("Runtime ownership", () => {
  test("rejects a second connection and releases idempotently", async () => {
    const filename = await storage()
    const owner = await acquire(filename)
    await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
    owner.release()
    owner.release()
    expect((await acquire(filename)).storage).toBe(filename)
  })

  test("normalizes directory symlinks before selecting the lock", async () => {
    if (process.platform === "win32") return
    const filename = await storage()
    const alias = `${path.dirname(filename)}-alias`
    await symlink(path.dirname(filename), alias)
    directories.push(alias)
    await acquire(filename)
    await expect(RuntimeOwnership.acquire(path.join(alias, "session.db"))).rejects.toBeInstanceOf(
      RuntimeOwnership.BusyError,
    )
  })

  test("different stores have independent ownership", async () => {
    const filename = await storage()
    await acquire(filename)
    expect((await acquire(`${filename}-other`)).storage).toBe(`${filename}-other`)
  })

  test("releases the OS lock after an abrupt process exit", async () => {
    const filename = await storage()
    const module = path.resolve(import.meta.dir, "../src/runtime/ownership.ts")
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { RuntimeOwnership } from ${JSON.stringify(module)};
      await RuntimeOwnership.acquire(${JSON.stringify(filename)});
      console.log("locked");
      await new Promise(() => {});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      const reader = child.stdout.getReader()
      const output = await reader.read()
      expect(new TextDecoder().decode(output.value)).toContain("locked")
      await expect(RuntimeOwnership.acquire(filename)).rejects.toBeInstanceOf(RuntimeOwnership.BusyError)
      child.kill("SIGKILL")
      await child.exited
      expect((await acquire(filename)).storage).toBe(filename)
    } finally {
      child.kill()
      await child.exited
    }
  })
})
