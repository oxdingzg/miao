import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { readWindow } from "../fixture/window-runtime"
import { RuntimeAttach } from "../../src/runtime/attach"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeRegistration } from "@miao/core/runtime/registration"
import { InstallationVersion } from "@miao/core/installation/version"

function environment(database: string, directory: string) {
  return {
    ...process.env,
    MIAO_DB: database,
    MIAO_PURE: "1",
    MIAO_TEST_HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_STATE_HOME: path.join(directory, "state"),
  }
}

test(
  "a window attaches to a live Runtime on the same storage",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-attach-first-"))
    const database = path.join(directory, "sessions.db")
    const child = Bun.spawn([process.execPath, "run", "test/runtime/fixture-host.ts"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: environment(database, directory),
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const deadline = Date.now() + 20_000
      let published: RuntimeRegistration.Record | undefined
      while (Date.now() < deadline && child.exitCode === null) {
        published = await readWindow(database)
        if (published) break
        await Bun.sleep(50)
      }
      if (!published) throw new Error(`Runtime did not start before the deadline (exit: ${child.exitCode ?? "running"})`)
      const attached = await RuntimeAttach.discover(database)
      expect(attached).toMatchObject({ runtimeID: published.runtimeID, url: published.url })

      // A stale record next to the live one never hides the live Runtime.
      const storage = await RuntimeOwnership.canonicalStorage(database)
      const credential = randomBytes(48).toString("hex")
      const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone") })
      const url = dead.url.href
      await dead.stop(true)
      const identity = RuntimeIdentity.create(storage, InstallationVersion, credential)
      identity.bind(url)
      await RuntimeRegistration.publish(storage, {
        url,
        runtimeID: identity.runtimeID,
        version: InstallationVersion,
        protocol: identity.protocol,
        storageID: identity.storageID,
        credential,
      })
      expect((await RuntimeAttach.discover(database))?.runtimeID).toBe(published.runtimeID)

      // A Runtime on another storage in the same directory is never attached.
      expect(await RuntimeAttach.discover(path.join(directory, "other.db"))).toBeUndefined()
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM")
      await child.exited
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  process.platform === "win32" ? 90_000 : 30_000,
)

test("a stale record for a storage with no live Runtime never attaches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-attach-stale-"))
  const database = path.join(directory, "sessions.db")
  try {
    const storage = await RuntimeOwnership.canonicalStorage(database)
    const credential = randomBytes(48).toString("hex")
    const identity = RuntimeIdentity.create(storage, InstallationVersion, credential)
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("gone") })
    const url = dead.url.href
    await dead.stop(true)
    identity.bind(url)
    await RuntimeRegistration.publish(storage, {
      url,
      runtimeID: identity.runtimeID,
      version: InstallationVersion,
      protocol: identity.protocol,
      storageID: identity.storageID,
      credential,
    })
    expect(await RuntimeAttach.discover(database)).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("a record from another protocol generation is never attached", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-attach-protocol-"))
  const database = path.join(directory, "sessions.db")
  // The listener is live: only the protocol gate may reject this record.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("future") })
  try {
    const storage = await RuntimeOwnership.canonicalStorage(database)
    const file = `${storage}.runtime-${crypto.randomUUID()}.json`
    await Bun.write(
      file,
      JSON.stringify({
        url: server.url.href,
        runtimeID: crypto.randomUUID(),
        version: InstallationVersion,
        protocol: 2,
        storageID: createHash("sha256").update(storage).digest("hex"),
        credential: randomBytes(48).toString("hex"),
      }),
    )
    await chmod(file, 0o600)
    expect(await RuntimeAttach.discover(database)).toBeUndefined()
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("a window with a different configuration starts its own Runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-attach-config-"))
  const database = path.join(directory, "sessions.db")
  // The listener is live: only the configuration gate may reject this record.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") })
  try {
    const storage = await RuntimeOwnership.canonicalStorage(database)
    const credential = randomBytes(48).toString("hex")
    const identity = RuntimeIdentity.create(storage, InstallationVersion, credential)
    identity.bind(server.url.href)
    await RuntimeRegistration.publish(storage, {
      url: server.url.href,
      runtimeID: identity.runtimeID,
      version: InstallationVersion,
      protocol: identity.protocol,
      storageID: identity.storageID,
      credential,
      configurationID: "cd".repeat(32),
    })
    expect(await RuntimeAttach.discover(database)).toBeUndefined()
  } finally {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
