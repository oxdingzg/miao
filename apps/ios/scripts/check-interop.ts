import { SecureChannel } from "../../../packages/remote-control/src/secure-channel"
import { PushContext } from "../../../packages/remote-control/src/push-context"
import assert from "node:assert/strict"

// JSON argv avoids shell expansion and keeps build-host details in private configuration.
const input = process.env.MIAO_SWIFT_PROBE_COMMAND
if (!input) throw new Error("Set MIAO_SWIFT_PROBE_COMMAND to a JSON argv array for the remotely built InteropProbe")
const command: unknown = JSON.parse(input)
if (!Array.isArray(command) || !command.length || !command.every((value) => typeof value === "string"))
  throw new Error("Invalid probe command")
const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
const reader = child.stdout.getReader()
const decoder = new TextDecoder()
const state = { buffer: "" }
async function line() {
  while (!state.buffer.includes("\n")) {
    const next = await reader.read()
    if (next.done) throw new Error("Swift probe closed before completing the exchange")
    state.buffer += decoder.decode(next.value, { stream: true })
    if (state.buffer.length > 1024 * 1024) throw new Error("Oversized probe response")
  }
  const index = state.buffer.indexOf("\n")
  const result = state.buffer.slice(0, index)
  state.buffer = state.buffer.slice(index + 1)
  return result
}
async function send(value: string) {
  child.stdin.write(`${value}\n`)
  await child.stdin.flush()
}
const timeout = setTimeout(() => child.kill(), 20000)
try {
  const host = JSON.parse(await line()) as { signingKey: string }
  const device = await SecureChannel.createIdentity()
  const client = await SecureChannel.startClient(device, {
    hostID: "interop-host-00000000",
    runtimeID: "interop-runtime-00000000",
  })
  await send(JSON.stringify(client.hello))
  const connected = await client.finish(JSON.parse(await line()), host.signingKey)
  await send(await connected.channel.seal(new TextEncoder().encode("TypeScript prompt")))
  const reply = JSON.parse(await line()) as { packet: string; plaintext: string }
  assert.equal(reply.plaintext, "TypeScript prompt")
  assert.equal(new TextDecoder().decode(await connected.channel.open(reply.packet)), "Swift result")
  const sender = await SecureChannel.createIdentity()
  const binding = {
    hostID: client.hello.hostID,
    runtimeID: client.hello.runtimeID,
    grantID: crypto.randomUUID(),
    grantVersion: 1,
    deviceID: host.signingKey,
    signalID: crypto.randomUUID(),
  }
  const payload = {
    sessionID: "session_native_push",
    projectID: "project_native_push",
    expiresAt: Date.now() + 300_000,
  }
  await send(
    JSON.stringify({
      binding,
      pinnedHostKey: sender.publicKey,
      context: await PushContext.seal(sender, binding, payload),
    }),
  )
  assert.deepEqual(JSON.parse(await line()), payload)
  child.stdin.end()
  assert.equal(await child.exited, 0)
  console.log("Bun/WebCrypto and Swift/CryptoKit signed handshake and bidirectional encryption passed")
  console.log("Signed device-encrypted push context and native host/routing rejection passed")
} finally {
  clearTimeout(timeout)
  child.kill()
  reader.releaseLock()
}
