import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeviceGrants } from "../src/grants"
import { SecureChannel } from "../src/secure-channel"
import { RemoteAccess } from "@miao/schema/remote-access"
import { Option, Schema } from "effect"

test("wire contracts retain canonical facade identity and omit absent status fields", () => {
  expect(DeviceGrants.Grant).toBe(RemoteAccess.Grant)
  expect(DeviceGrants.Permission).toBe(RemoteAccess.Permission)
  const status = Schema.decodeUnknownSync(RemoteAccess.Status)({ enabled: false, connected: false })
  expect(Schema.encodeSync(RemoteAccess.Status)(status)).toEqual({ enabled: false, connected: false })
  expect(Option.isNone(Schema.decodeUnknownOption(RemoteAccess.Permission)("device.admin"))).toBe(true)
})

describe("durable locally approved device grants", () => {
  test("keeps host identity and revocation versions across a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-grants-"))
    try {
      const filename = path.join(directory, "devices.json")
      const first = await DeviceGrants.load(filename)
      const device = await SecureChannel.createIdentity()
      const grant = await first.approve({
        publicKey: device.publicKey,
        label: "phone",
        permissions: ["read", "prompt"],
        projectIDs: ["project-one"],
        sessionIDs: [],
        expiresAt: Date.now() + 60_000,
      })
      const restarted = await DeviceGrants.load(filename)
      expect(restarted.hostID).toBe(first.hostID)
      expect(restarted.identity.publicKey).toBe(first.identity.publicKey)
      expect(restarted.active(device.publicKey)).toEqual([grant])
      await restarted.revoke(grant.id, 1)
      const afterRevocation = await DeviceGrants.load(filename)
      expect(afterRevocation.active(device.publicKey)).toEqual([])
      expect(afterRevocation.list()[0]).toMatchObject({ version: 2, revokedAt: expect.any(Number) })
      await expect(afterRevocation.revoke(grant.id, 1)).rejects.toThrow("version conflict")
      if (process.platform !== "win32") expect((await stat(filename)).mode & 0o777).toBe(0o600)
      // Persisted key material remains a usable, matching signing identity.
      const pending = await SecureChannel.startClient(device, { hostID: first.hostID, runtimeID: crypto.randomUUID() })
      const accepted = await SecureChannel.acceptClient(
        afterRevocation.identity,
        { hostID: pending.hello.hostID, runtimeID: pending.hello.runtimeID },
        crypto.randomUUID(),
        pending.hello,
        device.publicKey,
      )
      const client = await pending.finish(accepted.hello, first.identity.publicKey)
      expect(await client.channel.open(await accepted.channel.seal(new Uint8Array([42])))).toEqual(new Uint8Array([42]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("serializes concurrent owner approvals without losing records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-grants-"))
    try {
      const filename = path.join(directory, "devices.json")
      const store = await DeviceGrants.load(filename)
      const device = await SecureChannel.createIdentity()
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          store.approve({
            publicKey: device.publicKey,
            label: `device ${index}`,
            permissions: ["read"],
            projectIDs: [],
            sessionIDs: [`session-${index}`],
            expiresAt: Date.now() + 60_000,
          }),
        ),
      )
      expect((await DeviceGrants.load(filename)).list()).toHaveLength(8)
      await expect(
        store.approve({
          publicKey: device.publicKey,
          label: "empty",
          permissions: ["read"],
          projectIDs: [],
          sessionIDs: [],
          expiresAt: Date.now() + 60_000,
        }),
      ).rejects.toThrow("Invalid")
      await expect(
        store.approve({
          publicKey: device.publicKey,
          label: "expired",
          permissions: ["read"],
          projectIDs: ["project"],
          sessionIDs: [],
          expiresAt: Date.now() - 1,
        }),
      ).rejects.toThrow("Invalid")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects malformed or permissive storage rather than generating a replacement identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-grants-"))
    try {
      const filename = path.join(directory, "devices.json")
      await writeFile(filename, "{}", { mode: 0o600 })
      await expect(DeviceGrants.load(filename)).rejects.toThrow("Invalid device grant storage")
      expect(await readFile(filename, "utf8")).toBe("{}")
      await rm(filename)
      await writeFile(filename, "{}", { mode: 0o644 })
      if (process.platform !== "win32") await expect(DeviceGrants.load(filename)).rejects.toThrow("Unsafe")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("closing grant storage drains admitted revocation writes and prevents late mutations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-grants-close-"))
  try {
    const filename = path.join(directory, "devices.json")
    const store = await DeviceGrants.load(filename)
    const device = await SecureChannel.createIdentity()
    const grant = await store.approve({
      publicKey: device.publicKey,
      label: "phone",
      permissions: ["read"],
      sessionIDs: ["ses_shared"],
      projectIDs: [],
      expiresAt: Date.now() + 60000,
    })
    const revoked = store.revoke(grant.id, grant.version)
    await store.close()
    expect((await revoked).revokedAt).not.toBeNull()
    expect(store.active(device.publicKey)).toEqual([])
    const restored = await DeviceGrants.load(filename)
    expect(restored.list()).toMatchObject([{ id: grant.id, version: grant.version + 1, revokedAt: expect.any(Number) }])
    await expect(store.revoke(grant.id, grant.version + 1)).rejects.toThrow("storage closed")
    expect((await DeviceGrants.load(filename)).list()).toEqual(restored.list())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
