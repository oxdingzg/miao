import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PushRegistry } from "../src/push-registry"
import { HubAuth } from "../src/hub-auth"

async function deviceID() {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  return Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey)).toString("base64url")
}

test("Push registrations survive restart, rotate safely and expire with their real Hub login", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-push-registry-"))
  const filename = path.join(directory, "hub.db")
  const database = new Database(filename)
  const origin = "http://127.0.0.1:4600"
  const identity = await HubAuth.create({
    database,
    baseURL: origin,
    secret: "fixture-push-auth-secret-0000000000000000",
    allowLoopbackHTTP: true,
  })
  await identity.bootstrap({ email: "owner@example.invalid", password: "fixture-password-0001", name: "Owner" })
  const login = await identity.auth.handler(
    new Request(origin + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.invalid", password: "fixture-password-0001" }),
    }),
  )
  const access = await identity.auth.handler(
    new Request(origin + "/api/auth/token", {
      headers: { origin, authorization: `Bearer ${login.headers.get("set-auth-token")!}` },
    }),
  )
  const principal = await identity.verify(((await access.json()) as { token: string }).token)
  PushRegistry.migrate(database)
  const registry = PushRegistry.open(database)
  const first = { deviceID: await deviceID(), token: "AB".repeat(32), environment: "sandbox" as const }
  const second = { deviceID: await deviceID(), token: "cd".repeat(32), environment: "production" as const }
  try {
    await registry.register(principal, first, () => identity.active(principal))
    expect(registry.targets(principal.accountID)).toHaveLength(1)
    expect(registry.targets("another-account")).toHaveLength(0)
    const stale = registry.targets(principal.accountID)[0]!
    expect(stale.token).toBe(first.token.toLowerCase())
    const rotated = await registry.register(principal, { ...first, token: "ef".repeat(32) }, () => true)
    expect(rotated.registeredAt).toBeGreaterThan(stale.registeredAt)
    expect(registry.invalidate(stale, Date.now() + 1000)).toBe(false)
    const fresh = registry.targets(principal.accountID)[0]!
    expect(registry.invalidate(fresh, fresh.registeredAt - 1)).toBe(false)
    expect(registry.invalidate(fresh, fresh.registeredAt)).toBe(true)
    await registry.register(principal, first, () => true)
    const beforeRefresh = registry.targets(principal.accountID)[0]!
    await registry.register(principal, first, () => true)
    expect(registry.targets(principal.accountID)[0]?.registrationID).not.toBe(beforeRefresh.registrationID)
    expect(registry.invalidate(beforeRefresh, Date.now() + 1000)).toBe(false)
    await expect(
      registry.register(principal, { ...second, token: first.token, environment: first.environment }, () => true),
    ).rejects.toThrow()
    await expect(registry.register(principal, second, () => false)).rejects.toThrow("revoked")
    await expect(registry.register({ ...principal, accountID: "another-account" }, second, () => true)).rejects.toThrow(
      "revoked",
    )
    await registry.register(principal, second, () => true)
    const expired = { ...principal, expiresAt: 0 }
    await expect(registry.register(expired, second, () => true)).rejects.toThrow("expired")
    expect(() => registry.revoke(expired, second.deviceID)).toThrow("expired")
    expect(registry.revoke(principal, first.deviceID)).toBe(true)
    expect(registry.targets(principal.accountID)).toHaveLength(1)
    database.close()
    const restoredDatabase = new Database(filename)
    try {
      const restored = PushRegistry.open(restoredDatabase)
      expect(restored.targets(principal.accountID)[0]?.deviceID).toBe(second.deviceID)
      restoredDatabase.query('DELETE FROM "session" WHERE id = ?').run(principal.sessionID)
      expect(restored.targets(principal.accountID)).toHaveLength(0)
      expect(restored.prune()).toBe(1)
      expect(
        restoredDatabase.query<{ count: number }, []>("SELECT count(*) AS count FROM hub_push_device").get()?.count,
      ).toBe(0)
    } finally {
      restoredDatabase.close()
    }
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("Push registry bounds device storage and rejects malformed identities", async () => {
  const database = new Database(":memory:")
  database.exec(
    'CREATE TABLE "user" (id TEXT PRIMARY KEY); CREATE TABLE "session" (id TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT)',
  )
  database.query('INSERT INTO "user" (id) VALUES (?)').run("fixture-account")
  database
    .query('INSERT INTO "session" (id, "userId", "expiresAt") VALUES (?, ?, ?)')
    .run("fixture-login", "fixture-account", new Date(Date.now() + 60_000).toISOString())
  const principal = { accountID: "fixture-account", sessionID: "fixture-login", expiresAt: Date.now() + 60_000 }
  PushRegistry.migrate(database)
  const registry = PushRegistry.open(database)
  try {
    await expect(
      registry.register(principal, { deviceID: "bad", token: "aa".repeat(32), environment: "sandbox" }, () => true),
    ).rejects.toThrow("identity")
    const first = { deviceID: await deviceID(), token: "00".repeat(32), environment: "sandbox" as const }
    await expect(registry.register(principal, { ...first, token: "bad/token" }, () => true)).rejects.toThrow("token")
    await registry.register(principal, first, () => true)
    for (const index of Array.from({ length: 31 }, (_, index) => index + 1))
      await registry.register(
        principal,
        { ...first, deviceID: await deviceID(), token: index.toString(16).padStart(64, "0") },
        () => true,
      )
    expect(registry.targets(principal.accountID)).toHaveLength(32)
    await expect(
      registry.register(principal, { ...first, deviceID: await deviceID(), token: "ff".repeat(32) }, () => true),
    ).rejects.toThrow("limit")
    await registry.register(principal, { ...first, token: "ee".repeat(32) }, () => true)
    expect(registry.targets(principal.accountID)).toHaveLength(32)
    database.query('UPDATE "session" SET "expiresAt" = ?').run(new Date(0).toISOString())
    expect(registry.targets(principal.accountID)).toHaveLength(0)
    expect(registry.prune()).toBe(32)
    database.query("UPDATE hub_push_schema SET version = 999").run()
    expect(() => PushRegistry.open(database)).toThrow("migration")
    expect(() => PushRegistry.migrate(database)).toThrow("Unsupported")
  } finally {
    database.close()
  }
})
