import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ControlAgent } from "../../../packages/remote-control/src/agent"
import { DeviceGrants } from "../../../packages/remote-control/src/grants"
import { ControlHub } from "../../../packages/remote-control/src/hub"
import { SecureChannel } from "../../../packages/remote-control/src/secure-channel"

// Run the approved-host/CI-built native probe on the same machine as this harness.
// This is a test-only local pairing; production must use locally confirmed grants.
const command: unknown = JSON.parse(process.env.MIAO_SWIFT_TRANSPORT_PROBE_COMMAND ?? "[]")
if (!Array.isArray(command) || !command.length || !command.every((value) => typeof value === "string" && value.length))
  throw new Error("Configure the native transport probe argv")
const argv: string[] = command
const directory = await mkdtemp(path.join(os.tmpdir(), "miao-native-transport-"))
const state: { hub?: ReturnType<typeof ControlHub.listen>; agent?: ReturnType<typeof ControlAgent.connect> } = {}
try {
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const privateKey = await crypto.subtle.exportKey("jwk", device.keys.privateKey)
  const grant = await grants.approve({ publicKey: device.publicKey, label: "native test", permissions: ["read", "prompt"],
    projectIDs: ["project-one"], sessionIDs: [], expiresAt: Date.now() + 60_000 })
  const runtimeID = crypto.randomUUID()
  const token = crypto.randomUUID() + crypto.randomUUID()
  state.hub = ControlHub.listen({ port: 0, hosts: new Map([[grants.hostID, token]]) })
  const hubURL = `http://127.0.0.1:${state.hub.port}`
  state.agent = ControlAgent.connect({ hubURL, hostToken: token, runtimeID, grants, allowLoopbackHTTP: true,
    projectForSession: async (sessionID) => sessionID === "session-one" ? "project-one" : undefined,
    methods: {
      capabilities: async () => ({ protocol: 1 }),
      "session.get": async () => ({ title: "shared session" }),
      "session.history": async () => ({ text: "history ".repeat(40_000) }),
      "session.prompt": async (request) => {
        setTimeout(() => { void state.agent?.revoke(grant.id, grant.version) }, 100)
        return { accepted: true, operationID: request.operationID }
      },
    },
  })
  const deadline = Date.now() + 3000
  while (!state.agent.connected() && Date.now() < deadline) await Bun.sleep(5)
  if (!state.agent.connected()) throw new Error("Test Agent did not connect")
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 25_000)
  try {
    child.stdin.write(JSON.stringify({ host: { id: crypto.randomUUID(), label: "native test", hubURL,
      target: { hostID: grants.hostID, runtimeID }, publicKey: grants.identity.publicKey,
      grantID: grant.id, grantVersion: grant.version }, devicePrivateKey: privateKey.d }))
    child.stdin.end()
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    if (await child.exited !== 0) throw new Error(`Native transport probe failed: ${(await errors).slice(0, 4096)}`)
    const result: unknown = JSON.parse((await output).slice(0, 4096))
    if (!result || typeof result !== "object" || !("nativeTransport" in result) || result.nativeTransport !== true)
      throw new Error("Native transport probe returned no success")
    console.log("Native URLSession ↔ Agent ↔ Hub transport, encrypted chunk reconstruction and operation IDs passed")
  } finally { clearTimeout(timeout); child.kill() }
} finally {
  state.agent?.stop()
  await state.hub?.stop()
  await rm(directory, { recursive: true, force: true })
}
