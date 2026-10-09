import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { HubService } from "../src/hub-service"
import { HubAuth } from "../src/hub-auth"
import { HubRoster } from "../src/hub-roster"
import { DeviceRoster } from "../src/device-roster"
import { SecureChannel } from "../src/secure-channel"

const accountID = "account_" + "a".repeat(24)
const otherID = "account_" + "b".repeat(24)

test("Hub roster storage isolates accounts and atomically rejects forks while bounding sparse history", async () => {
  const database = new Database(":memory:")
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE "user"(id TEXT PRIMARY KEY)')
  database.query('INSERT INTO "user" VALUES (?)').run(accountID)
  database.query('INSERT INTO "user" VALUES (?)').run(otherID)
  HubRoster.migrate(database)
  HubRoster.migrate(database)
  const store = HubRoster.open(database)
  const identity = await SecureChannel.createIdentity()
  const payload = (sequence: number): DeviceRoster.Roster => ({
    version: 1,
    accountID,
    sequence,
    issuedAt: 0,
    devices: [{ publicKey: identity.publicKey, label: "Owner", signer: true, addedAt: 0 }],
  })
  const update = async (sequence: number) => {
    const signed = await DeviceRoster.sign(identity, payload(sequence))
    return {
      sequence,
      payload: signed.roster,
      signature: signed.signature,
      digest: await DeviceRoster.fingerprint(signed.roster),
    }
  }
  try {
    const first = await update(1)
    expect(store.get(accountID)).toBeNull()
    expect(await store.put(accountID, first)).toMatchObject({ accountID, sequence: 1, payload: first.payload })
    expect(store.get(otherID)).toBeNull()
    await expect(store.put(otherID, first)).rejects.toThrow("mismatch")
    await expect(store.put(accountID, first)).rejects.toThrow("conflict")
    const next = await update(2)
    await expect(store.put(accountID, { ...next, digest: "a".repeat(43) })).rejects.toThrow("digest")
    await expect(store.put(accountID, next, () => false)).rejects.toThrow("revoked")
    expect(store.get(accountID)?.sequence).toBe(1)
    const concurrent = await Promise.allSettled([store.put(accountID, next), store.put(accountID, next)])
    expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    const unknown = { ...next, sequence: 3, payload: { ...next.payload, sequence: 3, injected: true } }
    await expect(store.put(accountID, unknown)).rejects.toThrow()
    for (let n = 3; n < 23; n++) await store.put(accountID, await update(n * 10))
    expect(store.history(accountID)).toHaveLength(16)
    expect(store.history(accountID)[0]?.sequence).toBe(220)
    expect(store.history(otherID)).toHaveLength(0)
    // Hub storage is not signer authorization: a self-signed account payload still requires a local pin.
    const fake = await SecureChannel.createIdentity()
    const signed = await DeviceRoster.sign(fake, payload(221))
    await store.put(accountID, {
      sequence: 221,
      payload: signed.roster,
      signature: signed.signature,
      digest: await DeviceRoster.fingerprint(signed.roster),
    })
    await expect(
      DeviceRoster.accept(signed, { accountID, acceptedSequence: 220, signerKeys: [identity.publicKey] }),
    ).rejects.toThrow("not locally trusted")
  } finally {
    database.close()
  }
})

test("Roster HTTP transport requires live account authentication, bounds input and exposes no other account roster", async () => {
  const database = new Database(":memory:")
  const baseURL = "http://127.0.0.1:4600"
  const secret = "test-roster-secret-000000000000000000000000000"
  const server = await HubService.listen({
    database,
    baseURL,
    secret,
    allowLoopbackHTTP: true,
    port: 0,
    migrate: true,
    bootstrap: { name: "Owner", email: "owner@example.invalid", password: "fixture-password-0001" },
  })
  const url = `http://127.0.0.1:${server.port}`
  const request = (route: string, token?: string, method = "GET", body?: unknown, origin = baseURL) =>
    fetch(url + route, {
      method,
      headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  const login = async (email: string, password: string) => {
    const response = await request("/api/auth/sign-in/email", undefined, "POST", { email, password })
    expect(response.status).toBe(200)
    const login = response.headers.get("set-auth-token")!
    const issued = await request("/api/auth/token", login)
    expect(issued.status).toBe(200)
    return { login, access: ((await issued.json()) as { token: string }).token }
  }
  try {
    expect((await request("/api/hub/roster")).status).toBe(401)
    const owner = await login("owner@example.invalid", "fixture-password-0001")
    const ownerID = database.query<{ id: string }, []>('SELECT id FROM "user"').get()!.id
    const identity = await SecureChannel.createIdentity()
    const signed = await DeviceRoster.sign(identity, {
      version: 1,
      accountID: ownerID,
      sequence: 1,
      issuedAt: 0,
      devices: [{ publicKey: identity.publicKey, label: "Owner", signer: true, addedAt: 0 }],
    })
    const update = {
      sequence: 1,
      payload: signed.roster,
      signature: signed.signature,
      digest: await DeviceRoster.fingerprint(signed.roster),
    }
    expect(await (await request("/api/hub/roster", owner.access)).json()).toEqual({ roster: null })
    expect(
      (await request("/api/hub/roster", owner.access, "PUT", update, "https://other.example.invalid")).status,
    ).toBe(403)
    expect(
      (await request("/api/hub/roster", owner.access, "PUT", { ...update, payload: { ...signed.roster, accountID } }))
        .status,
    ).toBe(400)
    const accepted = await request("/api/hub/roster", owner.access, "PUT", update)
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get("cache-control")).toBe("no-store")
    expect(await accepted.json()).toMatchObject({ roster: { accountID: ownerID, sequence: 1, payload: signed.roster } })
    expect((await request("/api/hub/roster", owner.access, "PUT", update)).status).toBe(409)
    expect((await request("/api/hub/roster", owner.access, "PUT", "x".repeat(65537))).status).toBe(413)
    expect(await (await request("/api/hub/roster/devices", owner.access)).json()).toEqual({
      devices: signed.roster.devices,
    })
    expect(await (await request("/api/hub/roster/history", owner.access)).json()).toMatchObject({
      history: [{ sequence: 1, digest: update.digest }],
    })
    const auth = await HubAuth.create({ database, baseURL, secret, allowLoopbackHTTP: true })
    const context = await auth.auth.$context
    const other = await context.internalAdapter.createUser(
      { name: "Other", email: "other@example.invalid", emailVerified: false },
      { method: "admin" },
    )
    await context.internalAdapter.createAccount({
      userId: other.id,
      accountId: other.id,
      providerId: "credential",
      password: await context.password.hash("fixture-password-0002"),
    })
    const foreign = await login("other@example.invalid", "fixture-password-0002")
    expect(await (await request("/api/hub/roster", foreign.access)).json()).toEqual({ roster: null })
    expect(await (await request("/api/hub/roster/devices", foreign.access)).json()).toEqual({ devices: [] })
    expect((await request("/api/hub/roster", foreign.access, "PUT", update)).status).toBe(400)
    expect((await request("/api/auth/sign-out", owner.login, "POST", {})).status).toBe(200)
    expect((await request("/api/hub/roster", owner.access)).status).toBe(401)
    expect((await request("/api/hub/roster", owner.access, "PUT", update)).status).toBe(401)
  } finally {
    await server.stop()
    database.close()
  }
})
