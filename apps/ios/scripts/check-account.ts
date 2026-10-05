import { Database } from "bun:sqlite"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { HubService } from "../../../packages/remote-control/src/hub-service"
import { SecureChannel } from "../../../packages/remote-control/src/secure-channel"

const directory = await mkdtemp(path.join(tmpdir(), "miao-native-account-"))
const database = new Database(":memory:")
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
const port = reservation.port
await reservation.stop(true)
const owner = { email: "probe@example.invalid", password: crypto.randomUUID() + crypto.randomUUID(), name: "Probe" }
const state: { hub?: Awaited<ReturnType<typeof HubService.listen>>; child?: ReturnType<typeof Bun.spawn> } = {}
try {
  state.hub = await HubService.listen({
    database,
    baseURL: `http://127.0.0.1:${port}`,
    secret: crypto.randomUUID() + crypto.randomUUID(),
    allowLoopbackHTTP: true,
    migrate: true,
    bootstrap: owner,
    hostname: "127.0.0.1",
    port,
  })
  const origin = `http://127.0.0.1:${port}`
  const signIn = await fetch(origin + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: owner.password }),
    signal: AbortSignal.timeout(15_000),
  })
  const login = signIn.headers.get("set-auth-token")
  await signIn.arrayBuffer()
  if (!signIn.ok || !login) throw new Error("Private account fixture login failed")
  const tokenResponse = await fetch(origin + "/api/auth/token", {
    headers: { origin, authorization: "Bearer " + login },
    signal: AbortSignal.timeout(15_000),
  })
  if (!tokenResponse.ok) throw new Error("Private account fixture token failed")
  const token: unknown = await tokenResponse.json()
  if (!token || typeof token !== "object" || !("token" in token) || typeof token.token !== "string")
    throw new Error("Private account fixture returned no signed token")
  const host = {
    hostID: crypto.randomUUID(),
    name: "电脑 / 原生目录",
    publicKey: (await SecureChannel.createIdentity()).publicKey,
  }
  const registration = await fetch(origin + "/api/hub/hosts", {
    method: "POST",
    headers: { origin, authorization: "Bearer " + token.token, "content-type": "application/json" },
    body: JSON.stringify(host),
    signal: AbortSignal.timeout(15_000),
  })
  await registration.arrayBuffer()
  if (registration.status !== 201) throw new Error("Private account fixture host registration failed")
  const fixture = path.join(directory, "fixture.json")
  await Bun.write(
    fixture,
    JSON.stringify({
      origin,
      email: owner.email,
      password: owner.password,
      hostID: host.hostID,
      hostName: host.name,
      hostPublicKey: host.publicKey,
    }),
  )
  await chmod(fixture, 0o600)
  state.child = Bun.spawn(["sh", "apps/ios/scripts/test-account.sh", fixture], { stdout: "pipe", stderr: "pipe" })
  const output = new Response(state.child.stdout).text()
  const errors = new Response(state.child.stderr).text()
  const timer = setTimeout(() => state.child?.kill(), 300_000)
  try {
    const code = await state.child.exited
    const log = await output
    await errors
    // simctl can return success when the application exits with an error; require the probe's explicit result.
    if (code !== 0 || !log.split("\n").some((line) => line.trim() === '{"nativeAccount":true}')) {
      throw new Error("Native Hub account integration failed; private fixture output is not published")
    }
  } finally {
    clearTimeout(timer)
  }
  console.log("Native Hub login, signed bearer, directory, real Keychain restoration and logout invalidation passed")
} finally {
  state.child?.kill()
  await state.child?.exited
  await state.hub?.stop()
  database.close()
  await rm(directory, { recursive: true, force: true })
}
