import { Database } from "bun:sqlite"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ControlAgent } from "../../../packages/remote-control/src/agent"
import { DeviceGrants } from "../../../packages/remote-control/src/grants"
import { HubService } from "../../../packages/remote-control/src/hub-service"
import { SecureChannel } from "../../../packages/remote-control/src/secure-channel"

const directory = await mkdtemp(path.join(tmpdir(), "miao-native-account-"))
const database = new Database(":memory:")
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
const port = reservation.port
await reservation.stop(true)
const owner = { email: "probe@example.invalid", password: crypto.randomUUID() + crypto.randomUUID(), name: "Probe" }
const state: {
  hub?: Awaited<ReturnType<typeof HubService.listen>>
  child?: ReturnType<typeof Bun.spawn>
  agent?: ReturnType<typeof ControlAgent.connect>
  grants?: Awaited<ReturnType<typeof DeviceGrants.load>>
} = {}
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
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  state.grants = grants
  const device = await SecureChannel.createIdentity()
  const privateKey = await crypto.subtle.exportKey("jwk", device.keys.privateKey)
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "Native account probe",
    permissions: ["read"],
    projectIDs: ["project-one"],
    sessionIDs: [],
    expiresAt: Date.now() + 600_000,
  })
  const runtimeID = crypto.randomUUID()
  const host = {
    hostID: grants.hostID,
    name: "电脑 / 原生目录",
    publicKey: grants.identity.publicKey,
  }
  const registration = await fetch(origin + "/api/hub/hosts", {
    method: "POST",
    headers: { origin, authorization: "Bearer " + token.token, "content-type": "application/json" },
    body: JSON.stringify(host),
    signal: AbortSignal.timeout(15_000),
  })
  if (registration.status !== 201) throw new Error("Private account fixture host registration failed")
  const registered: unknown = await registration.json()
  if (!registered || typeof registered !== "object" || !("token" in registered) || typeof registered.token !== "string")
    throw new Error("Private account fixture returned no host credential")
  state.agent = ControlAgent.connect({
    hubURL: origin,
    hostToken: registered.token,
    runtimeID,
    grants,
    allowLoopbackHTTP: true,
    projectForSession: async () => "project-one",
    methods: {
      capabilities: async () => ({ protocol: 1 }),
      "session.get": async () => ({ title: "Account relay session" }),
    },
  })
  const deadline = Date.now() + 5000
  while (!state.agent.connected() && Date.now() < deadline) await Bun.sleep(10)
  if (!state.agent.connected()) throw new Error("Private account fixture Agent did not connect")
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
      host: {
        id: crypto.randomUUID(),
        label: host.name,
        hubURL: origin,
        target: { hostID: host.hostID, runtimeID },
        publicKey: host.publicKey,
        grantID: grant.id,
        grantVersion: grant.version,
      },
      devicePrivateKey: privateKey.d,
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
    const stderr = await errors
    // simctl can return success when the application exits with an error; require the probe's explicit result.
    if (code !== 0 || !log.split("\n").some((line) => line.trim() === '{"nativeAccount":true}')) {
      const stages = [...log.matchAll(/^NativeAccountStage:(fixture|login|directory|keychain|denyDevice|refreshRuntime|rpc|secondConnection|logout|disconnect|cleared)\s*$/gm)]
      console.log(JSON.stringify({
        nativeAccount: false,
        exitCode: code,
        stage: stages.at(-1)?.[1] ?? "notStarted",
        probeFailed: log.includes("Native account integration failed"),
        buildFailed: /BUILD FAILED|error: emit-module|error: compile command/.test(stderr),
        simulatorFailed: /Unable to boot|Unable to launch|Failed to launch|Unable to lookup/.test(stderr),
      }))
      throw new Error("Native Hub account integration failed; private fixture output is not published")
    }
  } finally {
    clearTimeout(timer)
  }
  console.log("Native Hub account, Keychain, authenticated encrypted relay and logout invalidation passed")
} finally {
  state.child?.kill()
  await state.child?.exited
  state.agent?.stop()
  await state.hub?.stop()
  await state.grants?.close()
  database.close()
  await rm(directory, { recursive: true, force: true })
}
