import { Database } from "bun:sqlite"
import { mkdtemp, rm, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HubService } from "../src/hub-service"
import { ControlAgent } from "../src/agent"
import { DeviceGrants } from "../src/grants"
import { DeviceRoster } from "../src/device-roster"
import { DeviceEnrollment } from "../src/device-enrollment"
import { SecureChannel } from "../src/secure-channel"

const binary = process.env.MIAO_NATIVE_ROSTER_PROBE
if (!binary) throw new Error("Supply a prebuilt RosterAdmissionProbe through MIAO_NATIVE_ROSTER_PROBE")
const directory = await mkdtemp(path.join(os.tmpdir(), "miao-native-roster-"))
const database = new Database(":memory:")
const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
const port = reserve.port!
reserve.stop(true)
const origin = `http://127.0.0.1:${port}`
const root = await SecureChannel.createIdentity()
const fixtureToken = crypto.randomUUID() + crypto.randomUUID()
let accountID = "",
  current: DeviceRoster.Signed | undefined,
  childKey = "",
  calls = 0
const hub = await HubService.listen({
  database,
  baseURL: origin,
  secret: "native-roster-fixture-secret-000000000000000000000",
  allowLoopbackHTTP: true,
  port,
  migrate: true,
  bootstrap: { name: "Native fixture", email: "native@example.invalid", password: "native-fixture-password-0001" },
})
const approvalServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname !== "/fixture/approve" || request.method !== "POST")
      return new Response(null, { status: 404 })
    if (request.headers.get("authorization") !== `Bearer ${fixtureToken}` || !current)
      return new Response(null, { status: 403 })
    const text = await request.text()
    if (text.length > 8192) return new Response(null, { status: 413 })
    const signed = JSON.parse(text)
    const approved = await DeviceEnrollment.approve(root, signed, {
      hubURL: origin,
      accountID,
      current,
      authority: {
        accountID,
        acceptedSequence: current.roster.sequence,
        acceptedDigest: await DeviceRoster.fingerprint(current.roster),
        signerKeys: [root.publicKey],
      },
      hosts: [{ hostID: grants.hostID, publicKey: grants.identity.publicKey }],
      allowLoopbackHTTP: true,
    })
    childKey = signed.payload.publicKey
    return Response.json(approved, { headers: { "cache-control": "no-store" } })
  },
})
let agent: ReturnType<typeof ControlAgent.connect> | undefined
try {
  const response = await fetch(origin + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: "native@example.invalid", password: "native-fixture-password-0001" }),
  })
  if (!response.ok) throw new Error("Fixture sign-in failed")
  const login = response.headers.get("set-auth-token")!
  const profile = (await response.json()) as { user: { id: string } }
  accountID = profile.user.id
  const issued = await fetch(origin + "/api/auth/token", { headers: { origin, authorization: `Bearer ${login}` } })
  if (!issued.ok) throw new Error("Fixture account token failed")
  const access = ((await issued.json()) as { token: string }).token
  const headers = { origin, "content-type": "application/json", authorization: `Bearer ${access}` }
  const registration = await fetch(origin + "/api/hub/hosts", {
    method: "POST",
    headers,
    body: JSON.stringify({ hostID: grants.hostID, name: "Native computer", publicKey: grants.identity.publicKey }),
  })
  if (!registration.ok) throw new Error(`Fixture host registration failed: ${registration.status}`)
  const hostToken = ((await registration.json()) as { token: string }).token
  const approvedRoot = await grants.approve({
    publicKey: root.publicKey,
    label: "Root",
    permissions: ["read"],
    projectIDs: [],
    sessionIDs: ["session-one"],
    expiresAt: Date.now() + 600000,
  })
  await grants.bindAccount({
    hubURL: origin,
    accountID,
    grantID: approvedRoot.id,
    grantVersion: approvedRoot.version,
    policy: {
      permissions: approvedRoot.permissions,
      projectIDs: approvedRoot.projectIDs,
      sessionIDs: approvedRoot.sessionIDs,
      expiresAt: approvedRoot.expiresAt,
    },
    allowLoopbackHTTP: true,
  })
  current = await DeviceRoster.sign(root, {
    version: 1,
    accountID,
    sequence: 1,
    issuedAt: Date.now(),
    devices: [{ publicKey: root.publicKey, label: "Root", signer: true, addedAt: Date.now() }],
  })
  const stored = await fetch(origin + "/api/hub/roster", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      sequence: 1,
      payload: current.roster,
      signature: current.signature,
      digest: await DeviceRoster.fingerprint(current.roster),
    }),
  })
  if (!stored.ok) throw new Error("Fixture initial roster failed")
  agent = ControlAgent.connect({
    hubURL: origin,
    hostToken,
    runtimeID: crypto.randomUUID(),
    grants,
    accountID,
    allowLoopbackHTTP: true,
    sessionEnabled: () => true,
    projectForSession: async () => "project-one",
    methods: {
      "session.get": async () => {
        calls++
        return { title: "Native admitted session" }
      },
    },
  })
  const deadline = Date.now() + 5000
  while (!agent.connected() && Date.now() < deadline) await Bun.sleep(10)
  if (!agent.connected()) throw new Error("Fixture Agent unavailable")
  const file = path.join(directory, "fixture.json")
  await Bun.write(
    file,
    JSON.stringify({
      origin,
      email: "native@example.invalid",
      password: "native-fixture-password-0001",
      approveURL: `http://127.0.0.1:${approvalServer.port}/fixture/approve`,
      fixtureToken,
      rootKey: root.publicKey,
    }),
  )
  await chmod(file, 0o600)
  const process = Bun.spawn([binary, file], { stdout: "pipe", stderr: "pipe" })
  const [code, output, errors] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0 || !output.includes("NATIVE_ROSTER_ADMISSION_PASS")) {
    console.error(output, errors)
    throw new Error("Native roster admission probe failed")
  }
  const managed = grants.list().filter((grant) => grant.publicKey === childKey)
  if (calls !== 2 || managed.length !== 1 || managed[0]!.version !== 1 || grants.list().length !== 2)
    throw new Error("Native reconnect replayed requests or accumulated grants")
  console.log(output.trim())
} finally {
  approvalServer.stop(true)
  agent?.stop()
  await grants.close()
  hub.stop()
  database.close()
  await rm(directory, { recursive: true, force: true })
}
