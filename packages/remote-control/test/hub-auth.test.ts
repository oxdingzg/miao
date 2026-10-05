import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { decodeJwt } from "jose"
import { HubAuth } from "../src/hub-auth"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("Private bootstrap, signed login, short access token and immediate revocation use the real auth framework", async () => {
  const database = new Database(":memory:")
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("Not found", { status: 404 }) })
  const baseURL = `http://127.0.0.1:${server.port}`
  try {
    const identity = await HubAuth.create({
      database,
      baseURL,
      allowLoopbackHTTP: true,
      secret: "test-auth-secret-000000000000000000000000000",
    })
    const accountID = await identity.bootstrap({
      email: "owner@example.invalid",
      password: "fixture-password-0001",
      name: "Owner",
    })
    expect(database.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 0 })
    await expect(
      identity.bootstrap({ email: "other@example.invalid", password: "fixture-password-0002", name: "Other" }),
    ).rejects.toThrow("already initialized")
    const handle = (route: string, body?: unknown, token?: string) =>
      identity.auth.handler(
        new Request(baseURL + "/api/auth" + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: baseURL,
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
    const registration = await handle("/sign-up/email", {
      email: "open@example.invalid",
      password: "fixture-password-0003",
      name: "Open",
    })
    expect(registration.status).not.toBe(200)
    const rejected = await handle("/sign-in/email", { email: "owner@example.invalid", password: "wrong-password-0000" })
    expect(rejected.status).not.toBe(200)
    const signedIn = await handle("/sign-in/email", {
      email: "owner@example.invalid",
      password: "fixture-password-0001",
    })
    expect(signedIn.status).toBe(200)
    const loginToken = signedIn.headers.get("set-auth-token")!
    expect(loginToken).toBeTruthy()
    await expect(identity.verify(loginToken)).rejects.toThrow()
    const access = await handle("/token", undefined, loginToken)
    expect(access.status).toBe(200)
    const value = (await access.json()) as { token: string }
    const principal = await identity.verify(value.token)
    expect(principal.accountID).toBe(accountID)
    expect(identity.active(principal)).toBe(true)
    const payload = decodeJwt(value.token)
    expect(payload.exp! - payload.iat!).toBe(900)
    expect(payload.email).toBeUndefined()
    expect(payload.name).toBeUndefined()
    expect(payload.token).toBeUndefined()
    const segments = value.token.split(".")
    const signature = Buffer.from(segments[2]!, "base64url")
    signature[0] = signature[0]! ^ 1
    segments[2] = signature.toString("base64url")
    await expect(identity.verify(segments.join("."))).rejects.toThrow()
    expect((await handle("/sign-out", {}, loginToken)).status).toBe(200)
    expect(identity.active(principal)).toBe(false)
    await expect(identity.verify(value.token)).rejects.toThrow("revoked or expired")
    expect((await handle("/token", undefined, loginToken)).status).not.toBe(200)
  } finally {
    await server.stop(true)
    database.close()
  }
})

test("Production auth configuration rejects cleartext and ambiguous origins", async () => {
  const database = new Database(":memory:")
  try {
    for (const baseURL of [
      "http://relay.example.invalid",
      "https://user:password@relay.example.invalid",
      "https://relay.example.invalid/path",
      "https://relay.example.invalid?q=token",
    ])
      await expect(
        HubAuth.create({ database, baseURL, secret: "test-auth-secret-000000000000000000000000000" }),
      ).rejects.toThrow()
    await expect(
      HubAuth.create({ database, baseURL: "https://relay.example.invalid", secret: "short" }),
    ).rejects.toThrow("too short")
  } finally {
    database.close()
  }
})

test("Administrator initialization excludes concurrent authentication instances", async () => {
  const database = new Database(":memory:")
  const options = {
    database,
    baseURL: "http://127.0.0.1:4600",
    allowLoopbackHTTP: true,
    secret: "test-auth-secret-000000000000000000000000000",
  }
  try {
    const first = await HubAuth.create(options)
    const second = await HubAuth.create(options)
    const results = await Promise.allSettled([
      first.bootstrap({ email: "first@example.invalid", password: "fixture-password-0001", name: "First" }),
      second.bootstrap({ email: "second@example.invalid", password: "fixture-password-0002", name: "Second" }),
    ])
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1)
    expect(database.query('SELECT count(*) AS count FROM "user"').get()).toEqual({ count: 1 })
    expect(database.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 0 })
  } finally {
    database.close()
  }
})

test("Authentication survives a database restart and rejects an expired persisted login", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-hub-auth-"))
  const filename = path.join(directory, "auth.db")
  const options = {
    baseURL: "http://127.0.0.1:4600",
    allowLoopbackHTTP: true,
    secret: "test-auth-secret-000000000000000000000000000",
  }
  const firstDatabase = new Database(filename)
  try {
    const first = await HubAuth.create({ ...options, database: firstDatabase })
    const accountID = await first.bootstrap({
      email: "owner@example.invalid",
      password: "fixture-password-0001",
      name: "Owner",
    })
    const login = await first.auth.handler(
      new Request(options.baseURL + "/api/auth/sign-in/email", {
        method: "POST",
        headers: { origin: options.baseURL, "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@example.invalid", password: "fixture-password-0001" }),
      }),
    )
    expect(login.status).toBe(200)
    const token = await first.auth.handler(
      new Request(options.baseURL + "/api/auth/token", {
        headers: { authorization: `Bearer ${login.headers.get("set-auth-token")!}` },
      }),
    )
    expect(token.status).toBe(200)
    const access = (await token.json()) as { token: string }
    const principal = await first.verify(access.token)
    firstDatabase.close()
    const secondDatabase = new Database(filename)
    try {
      const second = await HubAuth.create({ ...options, database: secondDatabase })
      expect((await second.verify(access.token)).accountID).toBe(accountID)
      await expect(
        second.bootstrap({ email: "other@example.invalid", password: "fixture-password-0002", name: "Other" }),
      ).rejects.toThrow("already initialized")
      secondDatabase
        .query('UPDATE "session" SET "expiresAt" = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), principal.sessionID)
      expect(second.active(principal)).toBe(false)
      await expect(second.verify(access.token)).rejects.toThrow("revoked or expired")
    } finally {
      secondDatabase.close()
    }
  } finally {
    firstDatabase.close()
    await rm(directory, { recursive: true, force: true })
  }
})
