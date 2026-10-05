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
  } finally { server.stop(); database.close() }
})

test("setup rejects plaintext before sending account credentials", async () => {
  let fetched = false
  await expect(HubSetup.connect({ hubURL: "http://relay.example.invalid", email: "owner@example.invalid",
    password: "private-password", name: "Workstation", fetch: async () => { fetched = true; throw new Error() },
    runtime: { get: async () => ({ enabled: false, connected: false }), configure: async () => ({ enabled: true, connected: false }) } })).rejects.toThrow("HTTPS")
  expect(fetched).toBe(false)
})
