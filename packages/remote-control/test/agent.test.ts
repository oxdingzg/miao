import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ControlAgent } from "../src/agent"
import { DeviceGrants } from "../src/grants"
import { ControlHub } from "../src/hub"
import { SecureChannel } from "../src/secure-channel"
import { ControlPairing } from "../src/pairing"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  methods: ControlAgent.Options["methods"],
  permissions: ReadonlyArray<DeviceGrants.Permission> = ["read", "prompt"],
  projectForSession: ControlAgent.Options["projectForSession"] = async (id) =>
    id === "session-one" ? "project-one" : "project-other",
  sessionEnabled?: ControlAgent.Options["sessionEnabled"],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-agent-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
  const device = await SecureChannel.createIdentity()
  const grant = await grants.approve({
    publicKey: device.publicKey,
    label: "phone",
    permissions,
    projectIDs: ["project-one"],
    sessionIDs: [],
    expiresAt: Date.now() + 60_000,
  })
  const token = "test-agent-credential-0000000000000000000000000000"
  const runtimeID = crypto.randomUUID()
  const hub = ControlHub.listen({ hosts: new Map([[grants.hostID, token]]), port: 0 })
  cleanup.push(() => hub.stop())
  const base = `http://127.0.0.1:${hub.port}`
  const pairing = ControlPairing.make({ grants, target: { hostID: grants.hostID, runtimeID }, hubURL: base })
  cleanup.push(() => pairing.stop())
  const agent = ControlAgent.connect({
    hubURL: base,
    hostToken: token,
    runtimeID,
    grants,
    methods,
    sessionEnabled,
    projectForSession,
    allowLoopbackHTTP: true,
    pairing,
  })
  cleanup.push(() => agent.stop())
  const deadline = Date.now() + 2000
  while (!agent.connected() && Date.now() < deadline) await Bun.sleep(5)
  expect(agent.connected()).toBe(true)
  return { base, agent, grants, device, grant, runtimeID, pairing }
}

async function socket(base: string, hostID: string) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/v1/client?hostID=${hostID}`)
  cleanup.push(() => ws.close())
  const queue: string[] = []
  const waiting: Array<(message: string) => void> = []
  ws.addEventListener("message", (event) => {
    const next = waiting.shift()
    if (next) next(String(event.data))
    else queue.push(String(event.data))
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true })
  })
  const receive = () =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Agent response timeout")), 3000)
          waiting.push((message) => {
            clearTimeout(timer)
            resolve(message)
          })
        })
  return { ws, receive }
}

async function client(f: Awaited<ReturnType<typeof fixture>>) {
  const transport = await socket(f.base, f.grants.hostID)
  const pending = await SecureChannel.startClient(f.device, { hostID: f.grants.hostID, runtimeID: f.runtimeID })
  transport.ws.send(Buffer.from(JSON.stringify(pending.hello)).toString("base64url"))
  const accepted = await pending.finish(
    JSON.parse(Buffer.from(await transport.receive(), "base64url").toString()),
    f.grants.identity.publicKey,
  )
  const request = (extra: Partial<ControlAgent.Request> = {}): ControlAgent.Request => ({
    version: 1,
    requestID: crypto.randomUUID(),
    hostID: f.grants.hostID,
    runtimeID: f.runtimeID,
    grantID: f.grant.id,
    grantVersion: f.grant.version,
    method: "session.get",
    sessionID: "session-one",
    payload: {},
    ...extra,
  })
  const send = async (input: unknown) =>
    transport.ws.send(await accepted.channel.seal(new TextEncoder().encode(JSON.stringify(input))))
  const receive = async (): Promise<Record<string, unknown>> =>
    JSON.parse(new TextDecoder().decode(await accepted.channel.open(await transport.receive())))
  return { ...transport, request, send, receive }
}
function closed(ws: WebSocket) {
  return new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }))
}

describe("outbound authorized encrypted Agent", () => {
  test("local publication gates existing project grants and pending encrypted replies", async () => {
    const visible = new Set<string>()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const f = await fixture(
      {
        "session.get": async () => {
          calls++
          entered()
          await blocked
          return { title: "must remain local" }
        },
      },
      ["read"],
      async () => "project-one",
      (id) => visible.has(id),
    )
    const peer = await client(f)
    await peer.send(peer.request())
    expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
    expect(calls).toBe(0)
    visible.add("session-one")
    await peer.send(peer.request())
    await started
    visible.delete("session-one")
    release()
    expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
    visible.add("session-one")
    await peer.send(peer.request())
    expect(await peer.receive()).toMatchObject({ type: "result", data: { title: "must remain local" } })
    expect(calls).toBe(2)
  })
  test("selection changes require their own capability, operation IDs and session scope", async () => {
    const calls: ControlAgent.Request[] = []
    const handler: ControlAgent.Handler = async (request) => {
      calls.push(request)
      return { status: "completed" }
    }
    const methods = { "session.switchAgent": handler, "session.switchModel": handler }
    const promptOnly = await fixture(methods, ["read", "prompt"])
    const denied = await client(promptOnly)
    for (const method of ["session.switchAgent", "session.switchModel"] as const) {
      await denied.send(denied.request({ method, operationID: crypto.randomUUID() }))
      expect(await denied.receive()).toMatchObject({ type: "error", code: "forbidden" })
    }
    const selectable = await fixture(methods, ["read", "session.selection"])
    const peer = await client(selectable)
    for (const method of ["session.switchAgent", "session.switchModel"] as const) {
      await peer.send(peer.request({ method }))
      expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
      await peer.send(peer.request({ method, sessionID: "another-session", operationID: crypto.randomUUID() }))
      expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
      await peer.send(
        peer.request({
          method,
          operationID: crypto.randomUUID(),
          payload:
            method === "session.switchAgent"
              ? { agent: "build" }
              : { model: { providerID: "fixture", id: "model", variant: "reasoning" } },
        }),
      )
      expect(await peer.receive()).toMatchObject({ type: "result", data: { status: "completed" } })
    }
    expect(calls.map((call) => call.method)).toEqual(["session.switchAgent", "session.switchModel"])
  })
  test("routes approved requests through real Hub and rejects out-of-scope or stale Runtime targets", async () => {
    const calls: ControlAgent.Request[] = []
    const f = await fixture({
      "session.get": async (request) => {
        calls.push(request)
        return { title: "private session" }
      },
    })
    const peer = await client(f)
    const request = peer.request()
    await peer.send(request)
    expect(await peer.receive()).toEqual({
      version: 1,
      type: "result",
      requestID: request.requestID,
      data: { title: "private session" },
    })
    await peer.send(peer.request({ sessionID: "another-session" }))
    expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
    await peer.send(peer.request({ runtimeID: crypto.randomUUID() }))
    expect(await peer.receive()).toMatchObject({ type: "error", code: "forbidden" })
    expect(calls).toHaveLength(1)
  })

  test("read-only grants cannot submit prompts and write operations need stable IDs", async () => {
    const calls: ControlAgent.Request[] = []
    const methods = {
      "session.prompt": async (request: ControlAgent.Request) => {
        calls.push(request)
        return { accepted: true }
      },
    }
    const readOnly = await fixture(methods, ["read"])
    const first = await client(readOnly)
    await first.send(first.request({ method: "session.prompt", operationID: crypto.randomUUID() }))
    expect(await first.receive()).toMatchObject({ type: "error", code: "forbidden" })
    const writable = await fixture(methods)
    const second = await client(writable)
    await second.send(second.request({ method: "session.prompt" }))
    expect(await second.receive()).toMatchObject({ type: "error", code: "forbidden" })
    const operationID = crypto.randomUUID()
    await second.send(second.request({ method: "session.prompt", operationID }))
    expect(await second.receive()).toMatchObject({ type: "result", data: { accepted: true } })
    expect(calls.map((request) => request.operationID)).toEqual([operationID])
  })

  test("unknown device keys and arbitrary administrative HTTP routes never reach handlers", async () => {
    const f = await fixture({
      "session.get": async () => {
        throw new Error("must not run")
      },
    })
    const unknown = await socket(f.base, f.grants.hostID)
    const hello = await SecureChannel.startClient(await SecureChannel.createIdentity(), {
      hostID: f.grants.hostID,
      runtimeID: f.runtimeID,
    })
    const rejected = closed(unknown.ws)
    unknown.ws.send(Buffer.from(JSON.stringify(hello.hello)).toString("base64url"))
    expect((await rejected).code).toBe(1008)
    const peer = await client(f)
    const denied = closed(peer.ws)
    await peer.send({ ...peer.request(), method: "runtime.stop" })
    expect((await denied).code).toBe(1008)
  })

  test("revocation closes live channels and discards requests waiting on scope lookup", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: ControlAgent.Request[] = []
    const f = await fixture(
      {
        "session.prompt": async (request) => {
          calls.push(request)
          return {}
        },
      },
      ["read", "prompt"],
      async () => {
        entered.resolve()
        await release.promise
        return "project-one"
      },
    )
    const peer = await client(f)
    await peer.send(peer.request({ method: "session.prompt", operationID: crypto.randomUUID() }))
    await entered.promise
    const disconnected = closed(peer.ws)
    await f.agent.revoke(f.grant.id, f.grant.version)
    release.resolve()
    expect((await disconnected).code).toBe(1008)
    await Bun.sleep(10)
    expect(calls).toEqual([])
  })

  test("large results use ordered encrypted chunks without truncating session history", async () => {
    const text = "history ".repeat(40_000)
    const f = await fixture({ "session.history": async () => ({ text }) })
    const peer = await client(f)
    const request = peer.request({ method: "session.history" })
    await peer.send(request)
    const first = await peer.receive()
    expect(first).toMatchObject({ type: "chunk", index: 0 })
    const chunks = [Buffer.from(String(first.payload), "base64url")]
    for (const index of Array.from({ length: Number(first.total) - 1 }, (_, index) => index + 1)) {
      const chunk = await peer.receive()
      expect(chunk).toMatchObject({ type: "chunk", transferID: first.transferID, total: first.total, index })
      chunks.push(Buffer.from(String(chunk.payload), "base64url"))
    }
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
      version: 1,
      type: "result",
      requestID: request.requestID,
      data: { text },
    })
  })

  test("bounds queued requests while a handler is awaiting an authoritative response", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    cleanup.push(() => release.resolve())
    const calls: string[] = []
    const f = await fixture({
      "session.get": async (request, context) => {
        calls.push(request.requestID)
        entered.resolve()
        await release.promise
        context.authorize()
        return {}
      },
    })
    const peer = await client(f)
    const disconnected = closed(peer.ws)
    await peer.send(peer.request())
    await entered.promise
    for (const _ of Array.from({ length: 9 })) await peer.send(peer.request())
    expect((await disconnected).code).toBe(1008)
    release.resolve()
    await Bun.sleep(10)
    expect(calls).toHaveLength(1)
  })

  test("rejects cleartext internet endpoints before starting a connection", async () => {
    const f = await fixture({})
    expect(() =>
      ControlAgent.connect({
        hubURL: "http://example.com",
        hostToken: "x".repeat(40),
        runtimeID: f.runtimeID,
        grants: f.grants,
        methods: {},
        projectForSession: async () => undefined,
      }),
    ).toThrow("HTTPS")
  })
})

test("provisional encrypted pairing through the Hub requires local approval before business access", async () => {
  const f = await fixture({ "session.get": async () => ({ title: "approved Session" }) })
  const device = await SecureChannel.createIdentity()
  const invitation = f.pairing.issue({
    permissions: ["read"],
    sessionIDs: ["session-one"],
    projectIDs: [],
    expiresAt: Date.now() + 60000,
  })
  const transport = await socket(f.base, f.grants.hostID)
  const pending = await SecureChannel.startClient(device, { hostID: f.grants.hostID, runtimeID: f.runtimeID })
  transport.ws.send(
    Buffer.from(
      JSON.stringify({
        pairingID: invitation.pairingID,
        label: "phone",
        hello: pending.hello,
        proof: ControlPairing.proof(invitation, "phone", pending.hello),
      }),
    ).toString("base64url"),
  )
  const accepted = await pending.finish(
    JSON.parse(Buffer.from(await transport.receive(), "base64url").toString()),
    invitation.hostPublicKey,
  )
  expect(JSON.parse(new TextDecoder().decode(await accepted.channel.open(await transport.receive())))).toMatchObject({
    type: "pairing",
    status: "pending",
  })
  expect(f.grants.active(device.publicKey)).toEqual([])
  const grant = await f.pairing.approve(invitation.pairingID, device.publicKey)
  expect(JSON.parse(new TextDecoder().decode(await accepted.channel.open(await transport.receive())))).toMatchObject({
    type: "pairing",
    status: "approved",
    grant: { id: grant.id },
  })
  transport.ws.send(
    await accepted.channel.seal(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          requestID: crypto.randomUUID(),
          hostID: f.grants.hostID,
          runtimeID: f.runtimeID,
          grantID: grant.id,
          grantVersion: grant.version,
          method: "session.get",
          sessionID: "session-one",
          payload: {},
        }),
      ),
    ),
  )
  expect(JSON.parse(new TextDecoder().decode(await accepted.channel.open(await transport.receive())))).toMatchObject({
    type: "result",
    data: { title: "approved Session" },
  })
})

test("business frames sent during pairing close the provisional channel without issuing a grant", async () => {
  const f = await fixture({
    "session.get": async () => {
      throw new Error("Must not dispatch")
    },
  })
  const device = await SecureChannel.createIdentity()
  const invitation = f.pairing.issue({
    permissions: ["read"],
    sessionIDs: ["session-one"],
    projectIDs: [],
    expiresAt: Date.now() + 60000,
  })
  const transport = await socket(f.base, f.grants.hostID)
  const pending = await SecureChannel.startClient(device, { hostID: f.grants.hostID, runtimeID: f.runtimeID })
  transport.ws.send(
    Buffer.from(
      JSON.stringify({
        pairingID: invitation.pairingID,
        label: "phone",
        hello: pending.hello,
        proof: ControlPairing.proof(invitation, "phone", pending.hello),
      }),
    ).toString("base64url"),
  )
  const accepted = await pending.finish(
    JSON.parse(Buffer.from(await transport.receive(), "base64url").toString()),
    invitation.hostPublicKey,
  )
  await accepted.channel.open(await transport.receive())
  const disconnect = closed(transport.ws)
  transport.ws.send(await accepted.channel.seal(new TextEncoder().encode("unapproved request")))
  expect((await disconnect).code).toBe(1008)
  expect(f.grants.active(device.publicKey)).toEqual([])
  expect(f.pairing.list()).toEqual([])
})
