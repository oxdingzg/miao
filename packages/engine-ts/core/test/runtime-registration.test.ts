import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { RuntimeIdentity } from "../src/runtime/identity"
import { RuntimeRegistration } from "../src/runtime/registration"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function storage() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-runtime-discovery-"))
  directories.push(directory)
  return path.join(directory, "sessions.db")
}

function fixture(filename: string, url: string) {
  const credential = randomBytes(48).toString("hex")
  const identity = RuntimeIdentity.create(filename, "test-version", credential)
  identity.bind(url)
  const record: RuntimeRegistration.Record = {
    url,
    runtimeID: identity.runtimeID,
    version: identity.version,
    protocol: identity.protocol,
    storageID: identity.storageID,
    credential,
  }
  return { identity, record }
}

describe("Runtime discovery", () => {
  test("persists privately and does not remove another Runtime's record", async () => {
    const filename = await storage()
    const item = fixture(filename, "http://127.0.0.1:4096/")
    expect(await RuntimeRegistration.read(filename, item.identity.runtimeID)).toBeUndefined()
    await RuntimeRegistration.publish(filename, item.record)
    expect(await RuntimeRegistration.read(filename, item.identity.runtimeID)).toEqual(item.record)
    if (process.platform !== "win32")
      expect((await stat(`${filename}.runtime-${item.identity.runtimeID}.json`)).mode & 0o777).toBe(0o600)
    await RuntimeRegistration.remove(filename, crypto.randomUUID())
    expect(await RuntimeRegistration.read(filename, item.identity.runtimeID)).toEqual(item.record)
    await RuntimeRegistration.remove(filename, item.identity.runtimeID)
    expect(await RuntimeRegistration.read(filename, item.identity.runtimeID)).toBeUndefined()
  })

  test("attests a live listener without disclosing credentials", async () => {
    const filename = await storage()
    const state: { item?: ReturnType<typeof fixture>; authorization?: string | null; count: number } = { count: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        state.count++
        state.authorization = request.headers.get("authorization")
        const challenge = new URL(request.url).searchParams.get("challenge")!
        expect(request.url).not.toContain(state.item!.record.credential)
        return Response.json(state.item!.identity.prove(challenge))
      },
    })
    state.item = fixture(filename, `http://127.0.0.1:${server.port}/`)
    try {
      const record = state.item.record
      expect(await RuntimeRegistration.attest(record, record)).toEqual(record)
      expect(state.authorization).toBeNull()
      await expect(RuntimeRegistration.attest(record, { ...record, version: "other" })).rejects.toThrow()
      await expect(RuntimeRegistration.attest(record, { ...record, storageID: "0".repeat(64) })).rejects.toThrow()
      expect(state.count).toBe(1)
    } finally {
      await server.stop(true)
    }
  })

  test("lists readable records and skips undecodable and foreign entries", async () => {
    const filename = await storage()
    const first = fixture(filename, "http://127.0.0.1:4096/")
    const second = fixture(filename, "http://127.0.0.1:4097/")
    expect(await RuntimeRegistration.list(filename)).toEqual([])
    await RuntimeRegistration.publish(filename, first.record)
    await RuntimeRegistration.publish(filename, second.record)
    const listed = await RuntimeRegistration.list(filename)
    expect(listed.map((record) => record.runtimeID).sort()).toEqual(
      [first.record.runtimeID, second.record.runtimeID].sort(),
    )
    // A record published for another storage never matches this one's prefix.
    const other = fixture(`${filename}-other`, "http://127.0.0.1:4098/")
    await RuntimeRegistration.publish(`${filename}-other`, other.record)
    await writeFile(`${filename}.runtime-${crypto.randomUUID()}.json`, '{"protocol":2}', { mode: 0o600 })
    expect(await RuntimeRegistration.list(filename)).toHaveLength(2)
  })

  test("rejects forged proofs, replayed challenges and replaced Runtime identities", () => {
    const item = fixture("canonical-storage", "http://127.0.0.1:4096/")
    const challenge = randomBytes(32).toString("hex")
    const proof = item.identity.prove(challenge)!
    expect(RuntimeIdentity.verify(proof, challenge, item.record.credential)).toBe(true)
    expect(RuntimeIdentity.verify(proof, randomBytes(32).toString("hex"), item.record.credential)).toBe(false)
    expect(
      RuntimeIdentity.verify({ ...proof, runtimeID: crypto.randomUUID() }, challenge, item.record.credential),
    ).toBe(false)
    expect(RuntimeIdentity.verify(proof, challenge, randomBytes(48).toString("hex"))).toBe(false)
    expect(() => item.identity.prove("short")).toThrow()
  })

  test("refuses redirects and never follows them with a secret", async () => {
    const state = { destination: 0, credentials: false }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        state.credentials ||= request.headers.has("authorization")
        if (new URL(request.url).pathname === "/destination") state.destination++
        return Response.redirect(new URL("/destination", request.url).href)
      },
    })
    const item = fixture(await storage(), `http://127.0.0.1:${server.port}/`)
    try {
      await expect(RuntimeRegistration.attest(item.record, item.record)).rejects.toThrow()
      expect(state.destination).toBe(0)
      expect(state.credentials).toBe(false)
    } finally {
      await server.stop(true)
    }
  })

  test("rejects a relayed valid proof from a different listener address", async () => {
    const filename = await storage()
    const item = fixture(filename, "http://127.0.0.1:4096/")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.has("authorization")).toBe(false)
        return Response.json(item.identity.prove(new URL(request.url).searchParams.get("challenge")!))
      },
    })
    try {
      await expect(
        RuntimeRegistration.attest({ ...item.record, url: `http://127.0.0.1:${server.port}/` }, item.record),
      ).rejects.toBeInstanceOf(RuntimeRegistration.IdentityError)
    } finally {
      await server.stop(true)
    }
  })

  test("refuses unsafe URLs, large files, insecure modes and symlinks", async () => {
    const filename = await storage()
    const item = fixture(filename, "http://127.0.0.1:4096/")
    for (const url of [
      "http://localhost:4096/",
      "https://127.0.0.1:4096/",
      "http://127.0.0.1:4096/?secret=x",
      "http://u:p@127.0.0.1:4096/",
    ]) {
      await expect(RuntimeRegistration.publish(filename, { ...item.record, url })).rejects.toThrow()
    }
    await writeFile(`${filename}.runtime-${item.identity.runtimeID}.json`, "x".repeat(4097), { mode: 0o600 })
    await expect(RuntimeRegistration.read(filename, item.identity.runtimeID)).rejects.toThrow()
    if (process.platform === "win32") return
    await RuntimeRegistration.publish(filename, item.record)
    await chmod(`${filename}.runtime-${item.identity.runtimeID}.json`, 0o644)
    await expect(RuntimeRegistration.read(filename, item.identity.runtimeID)).rejects.toThrow()
    await symlink(
      `${filename}.runtime-${item.identity.runtimeID}.json`,
      `${filename}-alias.runtime-${item.identity.runtimeID}.json`,
    )
    await expect(RuntimeRegistration.read(`${filename}-alias`, item.identity.runtimeID)).rejects.toThrow()
  })
})
