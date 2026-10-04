import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { HubAuth } from "../src/hub-auth"
import { HubDirectory } from "../src/hub-directory"
import { SecureChannel } from "../src/secure-channel"

test("Host routing identities are account isolated, durable and explicitly revoked", async () => {
  const database = new Database(":memory:")
  try {
    const auth = await HubAuth.create({
      database,
      baseURL: "http://127.0.0.1:4600",
      allowLoopbackHTTP: true,
      secret: "test-auth-secret-000000000000000000000000000",
    })
    const accountID = await auth.bootstrap({
      name: "Owner",
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    const context = await auth.auth.$context
    const other = await context.internalAdapter.createUser(
      { name: "Other", email: "other@example.invalid", emailVerified: false },
      { method: "admin" },
    )
    HubDirectory.migrate(database)
    const directory = HubDirectory.open(database)
    const identity = await SecureChannel.createIdentity()
    const hostID = crypto.randomUUID()
    const registered = await directory.register(accountID, {
      hostID,
      publicKey: identity.publicKey,
      name: "My computer",
    })
    expect(directory.authenticate(hostID, registered.token)).toBe(accountID)
    expect(directory.authenticate(hostID, "wrong-token")).toBeUndefined()
    expect(directory.list(accountID)).toEqual([registered.host])
    expect(directory.list(other.id)).toEqual([])
    expect(directory.belongs(other.id, hostID)).toBe(false)
    expect(directory.revoke(other.id, hostID)).toBe(false)
    expect(() => directory.rotate(other.id, hostID)).toThrow("unavailable")
    await expect(
      directory.register(other.id, { hostID, publicKey: identity.publicKey, name: "Other computer" }),
    ).rejects.toThrow("already registered")
    const reopened = HubDirectory.open(database)
    expect(reopened.authenticate(hostID, registered.token)).toBe(accountID)
    const rotated = reopened.rotate(accountID, hostID)
    expect(reopened.authenticate(hostID, registered.token)).toBeUndefined()
    expect(reopened.authenticate(hostID, rotated)).toBe(accountID)
    const raw = database.query<{ token_hash: Uint8Array }, []>("SELECT token_hash FROM hub_host").get()!
    expect(Buffer.from(raw.token_hash).length).toBe(32)
    expect(Buffer.from(raw.token_hash).toString()).not.toContain(rotated)
    expect(reopened.revoke(accountID, hostID)).toBe(true)
    expect(reopened.revoke(accountID, hostID)).toBe(false)
    expect(reopened.authenticate(hostID, rotated)).toBeUndefined()
    expect(reopened.belongs(accountID, hostID)).toBe(false)
    expect(reopened.list(accountID)[0]!.revokedAt).not.toBeNull()
    expect(() => reopened.rotate(accountID, hostID)).toThrow("unavailable")
  } finally {
    database.close()
  }
})

test("Metadata rejects unknown schemas and malformed or unowned host registrations", async () => {
  const database = new Database(":memory:")
  try {
    const auth = await HubAuth.create({
      database,
      baseURL: "http://127.0.0.1:4600",
      allowLoopbackHTTP: true,
      secret: "test-auth-secret-000000000000000000000000000",
    })
    const accountID = await auth.bootstrap({
      name: "Owner",
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    HubDirectory.migrate(database)
    const directory = HubDirectory.open(database)
    await expect(
      directory.register(accountID, { hostID: crypto.randomUUID(), publicKey: "A".repeat(87), name: "My computer" }),
    ).rejects.toThrow("public key")
    const identity = await SecureChannel.createIdentity()
    await expect(
      directory.register("missing-account", {
        hostID: crypto.randomUUID(),
        publicKey: identity.publicKey,
        name: "My computer",
      }),
    ).rejects.toThrow("account unavailable")
    expect(directory.list(accountID)).toEqual([])
    database.query("UPDATE hub_metadata_schema SET version = 2 WHERE id = 1").run()
    expect(() => HubDirectory.open(database)).toThrow("requires migration")
    expect(() => HubDirectory.migrate(database)).toThrow("Unsupported")
    expect(database.query("SELECT version FROM hub_metadata_schema WHERE id = 1").get()).toEqual({ version: 2 })
  } finally {
    database.close()
  }
})

test("Concurrent host registrations cannot exceed the account metadata budget", async () => {
  const database = new Database(":memory:")
  try {
    const auth = await HubAuth.create({
      database,
      baseURL: "http://127.0.0.1:4600",
      allowLoopbackHTTP: true,
      secret: "test-auth-secret-000000000000000000000000000",
    })
    const accountID = await auth.bootstrap({
      name: "Owner",
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    HubDirectory.migrate(database)
    const directory = HubDirectory.open(database)
    const identity = await SecureChannel.createIdentity()
    const results = await Promise.allSettled(
      Array.from({ length: 65 }, (_, index) =>
        directory.register(accountID, {
          hostID: crypto.randomUUID(),
          publicKey: identity.publicKey,
          name: `Computer ${index}`,
        }),
      ),
    )
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(64)
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1)
    expect(directory.list(accountID)).toHaveLength(64)
  } finally {
    database.close()
  }
})
