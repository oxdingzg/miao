import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { HubService } from "../src/hub-service"
import { HubSetup } from "../src/hub-setup"
import { SecureChannel } from "../src/secure-channel"

test("owner setup registers the Runtime key and sends only the host credential to Runtime", async () => {
  const database = new Database(":memory:")
  const server = await HubService.listen({ database, baseURL: "http://127.0.0.1:4600",
    secret: "test-auth-secret-000000000000000000000000000", allowLoopbackHTTP: true, port: 0, migrate: true,
    bootstrap: { name: "Owner", email: "owner@example.invalid", password: "fixture-password-0001" } })
  try {
    const identity = await SecureChannel.createIdentity()
    let configuration: { hubURL: string; hostToken: string } | undefined
    const status = { enabled: false, connected: false, hostID: "host_setup_fixture_001", hostPublicKey: identity.publicKey }
    const requests: string[] = []
    await HubSetup.connect({ hubURL: `http://127.0.0.1:${server.port}`, allowLoopbackHTTP: true,
      email: "owner@example.invalid", password: "fixture-password-0001", name: "Workstation",
      fetch: async (url, init) => { requests.push(String(url)); return fetch(url, init) },
      runtime: { get: async () => status, configure: async (value) => { configuration = value; return { ...status, enabled: true } } } })
    expect(configuration?.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(configuration?.hubURL).toBe(`http://127.0.0.1:${server.port}`)
    expect(requests.map((url) => new URL(url).pathname)).toEqual([
      "/api/auth/sign-in/email", "/api/auth/token", "/api/hub/hosts", "/api/auth/sign-out",
    ])
    expect(database.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 0 })
    const previousToken = configuration!.hostToken
    await HubSetup.connect({ hubURL: `http://127.0.0.1:${server.port}`, allowLoopbackHTTP: true,
      email: "owner@example.invalid", password: "fixture-password-0001", name: "Workstation",
      runtime: { get: async () => status, configure: async (value) => { configuration = value; return { ...status, enabled: true } } } })
    expect(configuration!.hostToken).not.toBe(previousToken)
    expect(database.query("SELECT count(*) AS count FROM hub_host").get()).toEqual({ count: 1 })
    expect(database.query('SELECT count(*) AS count FROM "session"').get()).toEqual({ count: 0 })
  } finally { server.stop(); database.close() }
})

test("setup rejects plaintext before sending account credentials", async () => {
  let fetched = false
  await expect(HubSetup.connect({ hubURL: "http://relay.example.invalid", email: "owner@example.invalid",
    password: "private-password", name: "Workstation", fetch: async () => { fetched = true; throw new Error() },
    runtime: { get: async () => ({ enabled: false, connected: false }), configure: async () => ({ enabled: true, connected: false }) } })).rejects.toThrow("HTTPS")
  expect(fetched).toBe(false)
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("provider discovery reports social providers and tolerates password-only relays", async () => {
  const advertised = await HubSetup.providers({
    hubURL: "https://relay.example.invalid",
    fetch: async () => json({ providers: ["github", "google"] }),
  })
  expect(advertised).toEqual({ providers: ["github", "google"] })

  const passwordOnly = await HubSetup.providers({
    hubURL: "https://relay.example.invalid",
    fetch: async () => new Response("not found", { status: 404 }),
  })
  expect(passwordOnly).toEqual({ providers: [] })

  const malformed = await HubSetup.providers({
    hubURL: "https://relay.example.invalid",
    fetch: async () => json({ providers: [42] }),
  })
  expect(malformed).toEqual({ providers: [] })
})

test("oauth setup signs in through the browser and registers the host", async () => {
  const identity = await SecureChannel.createIdentity()
  const status = { enabled: false, connected: false, hostID: "host_oauth_fixture_001", hostPublicKey: identity.publicKey }
  const hostToken = `host_${"a".repeat(40)}`
  let configuration: { hubURL: string; hostToken: string } | undefined
  let opened: string | undefined
  const requests: string[] = []
  const authorizeURL = "https://github.com/login/oauth/authorize?client_id=fixture"
  await HubSetup.connectWithOAuth({
    hubURL: "https://relay.example.invalid",
    provider: "github",
    name: "Workstation",
    callbackURL: "http://127.0.0.1:4599/",
    open: async (url) => {
      opened = url
    },
    waitForCode: async () => "one-time-code",
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      requests.push(path)
      const headers = init.headers as Record<string, string>
      if (path === "/api/auth/sign-in/social") {
        expect(JSON.parse(String(init.body))).toEqual({ provider: "github", callbackURL: "http://127.0.0.1:4599/" })
        return json({ redirect: true, url: authorizeURL })
      }
      if (path === "/api/auth/exchange") {
        expect(JSON.parse(String(init.body))).toEqual({ code: "one-time-code", client: "cli" })
        return json({ token: "access-token" })
      }
      if (path === "/api/hub/hosts") {
        expect(headers.authorization).toBe("Bearer access-token")
        return json({ token: hostToken })
      }
      if (path === "/api/auth/sign-out") {
        expect(headers.authorization).toBe("Bearer access-token")
        return json({})
      }
      throw new Error(`unexpected request: ${path}`)
    },
    runtime: {
      get: async () => status,
      configure: async (value) => {
        configuration = value
        return { ...status, enabled: true }
      },
    },
  })
  expect(opened).toBe(authorizeURL)
  expect(configuration).toEqual({ hubURL: "https://relay.example.invalid", hostToken })
  expect(requests).toEqual([
    "/api/auth/sign-in/social",
    "/api/auth/exchange",
    "/api/hub/hosts",
    "/api/auth/sign-out",
  ])
})

test("oauth setup surfaces an unusable authorize URL instead of a generic failure", async () => {
  const identity = await SecureChannel.createIdentity()
  const status = { enabled: false, connected: false, hostID: "host_oauth_fixture_002", hostPublicKey: identity.publicKey }
  await expect(
    HubSetup.connectWithOAuth({
      hubURL: "https://relay.example.invalid",
      provider: "github",
      name: "Workstation",
      callbackURL: "http://127.0.0.1:4599/",
      open: async (url) => {
        throw new Error(`Open this link in a browser to authorize this computer: ${url}`)
      },
      waitForCode: async () => "unused",
      fetch: async () => json({ redirect: true, url: "https://github.com/login/oauth/authorize?client_id=fixture" }),
      runtime: { get: async () => status, configure: async () => status },
    }),
  ).rejects.toThrow("Open this link in a browser")
})


test("provider discovery errors do not downgrade OAuth relays to password login", async () => {
  for (const status of [403, 502]) {
    await expect(HubSetup.providers({ hubURL: "https://relay.example.invalid", fetch: async () => json({ error: "private upstream body" }, status) }))
      .rejects.toThrow("could not be discovered")
  }
  await expect(HubSetup.providers({ hubURL: "https://relay.example.invalid", fetch: async () => { throw new Error("private transport error") } }))
    .rejects.toThrow("could not be discovered")
  await expect(HubSetup.providers({ hubURL: "https://relay.example.invalid", fetch: async () => json({ unexpected: true }) }))
    .rejects.toThrow("invalid login methods")
})
