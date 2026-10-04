import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ControlAgent } from "../../../packages/remote-control/src/agent"
import { ControlHub } from "../../../packages/remote-control/src/hub"
import { DeviceGrants } from "../../../packages/remote-control/src/grants"
import { ControlPairing } from "../../../packages/remote-control/src/pairing"
import { SecureChannel } from "../../../packages/remote-control/src/secure-channel"

const argv: unknown = JSON.parse(process.env.MIAO_SWIFT_PAIRING_PROBE_COMMAND ?? "null")
if (!Array.isArray(argv) || !argv.length || !argv.every((value) => typeof value === "string"))
  throw new Error("Set MIAO_SWIFT_PAIRING_PROBE_COMMAND to a JSON argv array for the remotely built native probe")

for (const testCase of [
  { failSave: false, largeGrant: false },
  { failSave: true, largeGrant: false },
  { failSave: false, largeGrant: true },
]) {
  const failSave = testCase.failSave
  const directory = await mkdtemp(path.join(tmpdir(), "miao-native-pairing-"))
  const state: { hub?: ReturnType<typeof ControlHub.listen>; agent?: ReturnType<typeof ControlAgent.connect> } = {}
  const calls: string[] = []
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const runtimeID = crypto.randomUUID()
  const token = crypto.randomUUID() + crypto.randomUUID()
  state.hub = ControlHub.listen({ port: 0, hosts: new Map([[grants.hostID, token]]) })
  const hubURL = `http://127.0.0.1:${state.hub.port}`
  const pairing = ControlPairing.make({ grants, hubURL, target: { hostID: grants.hostID, runtimeID } })
  try {
    state.agent = ControlAgent.connect({
      hubURL,
      hostToken: token,
      runtimeID,
      grants,
      pairing,
      allowLoopbackHTTP: true,
      projectForSession: async (sessionID) => (sessionID === "session-one" ? "project-one" : undefined),
      methods: {
        capabilities: async () => {
          calls.push("capabilities")
          return { protocol: 1 }
        },
        "session.get": async () => {
          calls.push("session.get")
          return { title: "paired session" }
        },
      },
    })
    const device = await SecureChannel.createIdentity()
    const privateKey = await crypto.subtle.exportKey("jwk", device.keys.privateKey)
    const sessionIDs = testCase.largeGrant
      ? ["session-one", ...Array.from({ length: 255 }, (_, index) => `${index}-${"会".repeat(124)}`)]
      : ["session-one"]
    const invitation = pairing.issue({
      permissions: ["read"],
      projectIDs: [],
      sessionIDs,
      expiresAt: Date.now() + 60_000,
    })
    const deadline = Date.now() + 10_000
    while (!state.agent.connected() && Date.now() < deadline) await Bun.sleep(5)
    if (!state.agent.connected()) throw new Error("Test Agent did not connect")
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const timeout = setTimeout(() => child.kill(), 25_000)
    try {
      child.stdin.write(
        JSON.stringify({
          uri: `miao://pair#${Buffer.from(JSON.stringify(invitation)).toString("base64url")}`,
          devicePrivateKey: privateKey.d,
          failSave,
          expectedSessionCount: sessionIDs.length,
        }),
      )
      child.stdin.end()
      const output = new Response(child.stdout).text()
      const errors = new Response(child.stderr).text()
      while (!pairing.list().length && Date.now() < deadline) await Bun.sleep(5)
      const candidate = pairing.list()[0]
      if (
        !candidate ||
        candidate.candidate.publicKey !== device.publicKey ||
        candidate.candidate.label !== "原生手机 / 🎤"
      )
        throw new Error("Native pairing did not verify the signed claim and Unicode HMAC transcript")
      if (calls.length) throw new Error("A business request ran before local owner approval")
      await pairing.approve(invitation.pairingID, device.publicKey)
      if ((await child.exited) !== 0) throw new Error(`Native pairing probe failed: ${(await errors).slice(0, 4096)}`)
      const result: unknown = JSON.parse((await output).slice(0, 4096))
      if (!result || typeof result !== "object" || !(failSave ? "saveFailed" in result : "nativePairing" in result))
        throw new Error("Native pairing probe returned no success")
      if (failSave ? calls.length !== 0 : calls.join(",") !== "capabilities,session.get")
        throw new Error("Native transport admitted work before saving approval")
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  } finally {
    state.agent?.stop()
    await pairing.stop()
    await state.hub?.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
console.log("Native invitation pairing, Unicode proof, owner approval, chunked grants and save-before-RPC passed")
