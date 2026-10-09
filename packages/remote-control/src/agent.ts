export * as ControlAgent from "./agent"

import { Option, Schema } from "effect"
import { SecureChannel } from "./secure-channel"
import { DeviceGrants } from "./grants"
import { DeviceRoster } from "./device-roster"
import { ControlPairing } from "./pairing"

// The Agent runs under Bun. Keep its authenticated constructor explicit when
// consumers also include DOM declarations, whose WebSocket lacks header options.
const HostWebSocket = WebSocket as unknown as {
  new (url: URL, options: { headers: Record<string, string> }): WebSocket
}

export const Method = Schema.Literals([
  "capabilities",
  "project.list",
  "session.list",
  "session.get",
  "session.history",
  "session.events",
  "session.pending",
  "session.diff",
  "selection.list",
  "operation.get",
  "session.create",
  "session.prompt",
  "session.interrupt",
  "session.rename",
  "session.switchAgent",
  "session.switchModel",
  "permission.reply",
  "question.reply",
])
export type Method = typeof Method.Type
const Identifier = Schema.String.check(Schema.isLengthBetween(1, 128))
const OperationID = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
)
const Request = Schema.Struct({
  version: Schema.Literal(1),
  requestID: OperationID,
  hostID: Identifier,
  runtimeID: Identifier,
  grantID: Identifier,
  grantVersion: Schema.Int,
  method: Method,
  sessionID: Schema.optional(Identifier),
  projectID: Schema.optional(Identifier),
  operationID: Schema.optional(OperationID),
  payload: Schema.Unknown,
})
export type Request = typeof Request.Type
const decodeRequest = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Request)))
const Envelope = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["connected", "disconnected"]), connectionID: Identifier, accountID: Schema.optional(DeviceRoster.AccountID) }),
  Schema.Struct({ type: Schema.Literal("frame"), connectionID: Identifier, payload: Schema.String }),
])
const decodeEnvelope = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Envelope)))

export class RequestError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "conflict" | "expired" | "outcome_unknown" | "invalid_request",
  ) {
    super(code)
  }
}
export type Context = {
  readonly grant: DeviceGrants.Grant
  readonly signal: AbortSignal
  /** Recheck after awaits, immediately before authoritative admission or disclosure. */
  readonly authorize: () => void
}
export type Handler = (request: Request, context: Context) => Promise<unknown>
export type Options = {
  readonly hubURL: string
  readonly hostToken: string
  readonly runtimeID: string
  readonly grants: DeviceGrants.Store
  readonly methods: Partial<Record<Method, Handler>>
  readonly projectForSession: (sessionID: string) => Promise<string | undefined>
  /** Local publication gate, rechecked after awaits and before encrypted disclosure. */
  readonly sessionEnabled?: (sessionID: string) => boolean
  readonly allowLoopbackHTTP?: boolean
  /** Account identity from authenticated host setup; never populated by a device claim. */
  readonly accountID?: string
  readonly pairing?: ReturnType<typeof ControlPairing.make>
}
const RosterClaim = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("rosterClaim"),
  accountID: DeviceRoster.AccountID,
  hello: Schema.Unknown,
  roster: Schema.optional(Schema.Unknown),
})
type Peer = {
  /** Set only by the authenticated Hub control channel, not client frames. */
  readonly accountID?: string
  readonly abort: AbortController
  readonly queue: { count: number; bytes: number; tail: Promise<void> }
  readonly timer: ReturnType<typeof setTimeout>
  key?: string
  channel?: SecureChannel.Channel
  pairing?: string
}
const required: Partial<Record<Method, DeviceGrants.Permission>> = {
  "session.create": "session.create",
  "session.prompt": "prompt",
  "session.interrupt": "interrupt",
  "session.rename": "session.rename",
  "session.switchAgent": "session.selection",
  "session.switchModel": "session.selection",
  "permission.reply": "permission.reply",
  "question.reply": "question.reply",
}
const sessionMethods = new Set<Method>([
  "session.get",
  "session.history",
  "session.events",
  "session.pending",
  "session.diff",
  "session.prompt",
  "session.interrupt",
  "session.rename",
  "session.switchAgent",
  "session.switchModel",
  "permission.reply",
  "question.reply",
])

/** One outbound host connection, automatically recovered without owning execution.
 * Handlers implement the explicit session contract; no HTTP tunnelling is exposed.
 */
export function connect(options: Options) {
  const url = new URL(options.hubURL)
  const local = options.allowLoopbackHTTP && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Hub requires a root HTTPS URL")
  url.protocol = local ? "ws:" : "wss:"
  url.pathname = "/v1/host"
  url.searchParams.set("hostID", options.grants.hostID)
  url.searchParams.set("runtimeID", options.runtimeID)
  if (options.hostToken.length < 32 || !/^[A-Za-z0-9_-]{16,128}$/.test(options.runtimeID))
    throw new Error("Invalid Agent connection configuration")
  const state = {
    stopped: false,
    socket: undefined as WebSocket | undefined,
    reconnect: undefined as ReturnType<typeof setTimeout> | undefined,
    attempts: 0,
    connected: false,
  }
  const peers = new Map<string, Peer>()
  function closePeer(id: string, notify = true) {
    const peer = peers.get(id)
    if (!peer) return
    peers.delete(id)
    clearTimeout(peer.timer)
    peer.abort.abort()
    if (notify && state.socket?.readyState === WebSocket.OPEN)
      state.socket.send(JSON.stringify({ type: "close", connectionID: id }))
  }
  function send(id: string, payload: string) {
    const socket = state.socket
    if (!peers.has(id) || socket?.readyState !== WebSocket.OPEN) throw new Error("Agent connection closed")
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.close(1013, "Reconnect and resynchronize")
      throw new Error("Agent backpressure limit")
    }
    socket.send(JSON.stringify({ type: "frame", connectionID: id, payload }))
  }
  async function reply(id: string, peer: Peer, result: unknown, check?: () => void) {
    if (!peer.channel || peer.abort.signal.aborted) return
    const bytes = Buffer.from(JSON.stringify(result))
    if (bytes.length > 8 * 1024 * 1024) throw new RequestError("invalid_request")
    if (bytes.length <= 96 * 1024) {
      const sealed = await peer.channel.seal(new Uint8Array(bytes))
      check?.()
      send(id, sealed)
      return
    }
    const transferID = crypto.randomUUID()
    const total = Math.ceil(bytes.length / (64 * 1024))
    for (const index of Array.from({ length: total }, (_, index) => index)) {
      if (peer.abort.signal.aborted) return
      const chunk = {
        version: 1,
        type: "chunk",
        transferID,
        index,
        total,
        payload: bytes.subarray(index * 64 * 1024, (index + 1) * 64 * 1024).toString("base64url"),
      }
      const sealed = await peer.channel.seal(new TextEncoder().encode(JSON.stringify(chunk)))
      check?.()
      send(id, sealed)
    }
  }
async function frame(id: string, peer: Peer, encoded: string) {
    if (peer.abort.signal.aborted) return
    if (!peer.channel) {
      const bytes = Buffer.from(encoded, "base64url")
      if (bytes.length > 65536 || bytes.toString("base64url") !== encoded) return closePeer(id)
      const hello: unknown = JSON.parse(bytes.toString("utf8"))
      if (typeof hello === "object" && hello !== null && "type" in hello && hello.type === "rosterClaim") {
        const claim = Schema.decodeUnknownSync(RosterClaim, { onExcessProperty: "error" })(hello)
        const trust = options.grants.accountTrust()
        if (
          !options.accountID ||
          claim.accountID !== options.accountID ||
          !trust ||
          trust.accountID !== options.accountID ||
          trust.hubURL !== new URL(options.hubURL).origin
        )
          return closePeer(id)
        const key =
          typeof claim.hello === "object" &&
          claim.hello !== null &&
          "signingKey" in claim.hello &&
          typeof claim.hello.signingKey === "string"
            ? claim.hello.signingKey
            : undefined
        if (!key) return closePeer(id)
        // Verify signed ClientHello ownership/target BEFORE any roster or grant mutation.
        const accepted = await SecureChannel.acceptClient(
          options.grants.identity,
          { hostID: options.grants.hostID, runtimeID: options.runtimeID },
          id,
          claim.hello,
          key,
        )
        if (peer.abort.signal.aborted) return closePeer(id)
        if (claim.roster !== undefined) {
          const candidate = Schema.decodeUnknownSync(DeviceRoster.Signed, { onExcessProperty: "error" })(claim.roster)
          const current = options.grants.accountTrust()
          if (!current) return closePeer(id)
          // Exact same-sequence envelopes are not reapplied; membership comes only from durable state.
          if (candidate.roster.sequence > current.acceptedSequence)
            await options.grants.acceptRoster(options.hubURL, candidate)
          else if (
            candidate.roster.sequence < current.acceptedSequence ||
            (await DeviceRoster.fingerprint(candidate.roster)) !== current.acceptedDigest
          )
            return closePeer(id)
        }
        if (peer.abort.signal.aborted) return closePeer(id)
        const grant = await options.grants.authorizeRosterDevice(options.hubURL, options.accountID, key)
        const check = () => {
          const current = options.grants.accountTrust()
          if (
            peer.abort.signal.aborted ||
            !current ||
            current.accountID !== options.accountID ||
            current.hubURL !== new URL(options.hubURL).origin ||
            !current.devices.some((device) => device.publicKey === key) ||
            options.grants.get(grant.id, key)?.version !== grant.version
          )
            throw new Error("Roster admission unavailable")
        }
        check()
        peer.key = key
        peer.channel = accepted.channel
        clearTimeout(peer.timer)
        send(id, Buffer.from(JSON.stringify(accepted.hello)).toString("base64url"))
        await reply(id, peer, { version: 1, type: "roster", status: "approved", grant }, check)
        return
      }
      if (bytes.length > 4096) return closePeer(id)
      if (options.pairing && hello && typeof hello === "object" && "pairingID" in hello) {
        peer.pairing = "pending"
        const claimed = await options.pairing.claim(hello, id)
        peer.pairing = claimed.pairingID
        clearTimeout(peer.timer)
        const cancel = () => options.pairing?.reject(claimed.pairingID)
        peer.abort.signal.addEventListener("abort", cancel, { once: true })
        if (peer.abort.signal.aborted) {
          cancel()
          return
        }
        peer.channel = claimed.channel
        send(id, Buffer.from(JSON.stringify(claimed.hello)).toString("base64url"))
        try {
          await reply(id, peer, { version: 1, type: "pairing", status: "pending", pairingID: claimed.pairingID })
          const grant = await claimed.result
          const check = () => {
            if (peer.abort.signal.aborted || options.grants.get(grant.id, grant.publicKey)?.version !== grant.version)
              throw new Error("Pairing unavailable")
          }
          check()
          peer.key = grant.publicKey
          await reply(id, peer, { version: 1, type: "pairing", status: "approved", grant }, check)
          peer.pairing = undefined
        } finally {
          peer.abort.signal.removeEventListener("abort", cancel)
        }
        return
      }
      const key =
        typeof hello === "object" && hello !== null && "signingKey" in hello && typeof hello.signingKey === "string"
          ? hello.signingKey
          : undefined
      if (!key || !options.grants.active(key).length) return closePeer(id)
      const accepted = await SecureChannel.acceptClient(
        options.grants.identity,
        { hostID: options.grants.hostID, runtimeID: options.runtimeID },
        id,
        hello,
        key,
      )
      if (peer.abort.signal.aborted || !options.grants.active(key).length) return closePeer(id)
      peer.key = key
      peer.channel = accepted.channel
      clearTimeout(peer.timer)
      send(id, Buffer.from(JSON.stringify(accepted.hello)).toString("base64url"))
      return
    }
    const decoded = decodeRequest(new TextDecoder().decode(await peer.channel.open(encoded)))
    if (Option.isNone(decoded)) return closePeer(id)
    const request = decoded.value
    try {
      const context = await authorize(options, peer, request)
      const handler = options.methods[request.method]
      if (!handler) throw new RequestError("invalid_request")
      context.authorize()
      const data = await handler(request, context)
      context.authorize()
      await reply(id, peer, { version: 1, type: "result", requestID: request.requestID, data }, context.authorize)
    } catch (error) {
      if (peer.abort.signal.aborted || !options.grants.active(peer.key!).length) return closePeer(id)
      await reply(id, peer, {
        version: 1,
        type: "error",
        requestID: request.requestID,
        code: error instanceof RequestError ? error.code : "unavailable",
      })
    }
  }
  function start() {
    if (state.stopped) return
    const socket = new HostWebSocket(url, { headers: { authorization: `Bearer ${options.hostToken}` } })
    state.socket = socket
    socket.onopen = () => {
      if (state.socket !== socket || state.stopped) return socket.close()
      state.connected = true
      state.attempts = 0
    }
    socket.onmessage = (event) => {
      if (state.socket !== socket || typeof event.data !== "string" || event.data.length > 256 * 1024) return
      const decoded = decodeEnvelope(event.data)
      if (Option.isNone(decoded)) return socket.close(1008, "Invalid Hub envelope")
      const envelope = decoded.value
      if (envelope.type === "disconnected") return closePeer(envelope.connectionID, false)
      if (envelope.type === "connected") {
        if (peers.size >= 64 || peers.has(envelope.connectionID)) {
          socket.send(JSON.stringify({ type: "close", connectionID: envelope.connectionID }))
          return
        }
        peers.set(envelope.connectionID, {
          accountID: envelope.accountID,
          abort: new AbortController(),
          queue: { count: 0, bytes: 0, tail: Promise.resolve() },
          timer: setTimeout(() => closePeer(envelope.connectionID), 10_000),
        })
        return
      }
      if (envelope.type !== "frame") return
      const peer = peers.get(envelope.connectionID)
      if (!peer) return
      // A provisional channel accepts no business requests, including queued
      // writes sent before local approval completes.
      if (peer.pairing) return closePeer(envelope.connectionID)
      if (peer.queue.count >= 8 || peer.queue.bytes + envelope.payload.length > 512 * 1024)
        return closePeer(envelope.connectionID)
      peer.queue.count++
      peer.queue.bytes += envelope.payload.length
      peer.queue.tail = peer.queue.tail
        .then(() => frame(envelope.connectionID, peer, envelope.payload))
        .catch(() => closePeer(envelope.connectionID))
        .finally(() => {
          peer.queue.count--
          peer.queue.bytes -= envelope.payload.length
        })
    }
    socket.onerror = () => socket.close()
    socket.onclose = () => {
      if (state.socket !== socket) return
      state.connected = false
      peers.forEach((_, id) => closePeer(id, false))
      if (state.stopped) return
      const delay = Math.min(30_000, 500 * 2 ** Math.min(state.attempts++, 6)) * (0.75 + Math.random() * 0.5)
      state.reconnect = setTimeout(start, delay)
    }
  }
  const expiry = setInterval(() => {
    peers.forEach((peer, id) => {
      if (peer.key && !options.grants.active(peer.key).length) closePeer(id)
    })
  }, 1000)
  start()
  return {
    connected: () => state.connected,
    revoke: async (id: string, version: number) => {
      const result = await options.grants.revoke(id, version)
      // Drop every device connection, including queued requests, on any grant change.
      peers.forEach((peer, id) => {
        if (peer.key === result.publicKey) closePeer(id)
      })
      return result
    },
    stop: () => {
      state.stopped = true
      clearInterval(expiry)
      clearTimeout(state.reconnect)
      peers.forEach((_, id) => closePeer(id, false))
      state.socket?.close(1000, "Agent stopped")
    },
  }
}

async function authorize(options: Options, peer: Peer, request: Request): Promise<Context> {
  const grant = options.grants.get(request.grantID, peer.key!)
  if (
    !grant ||
    grant.version !== request.grantVersion ||
    request.hostID !== options.grants.hostID ||
    request.runtimeID !== options.runtimeID
  )
    throw new RequestError("forbidden")
  const permission = required[request.method] ?? "read"
  if (!grant.permissions.includes(permission) || (required[request.method] && !request.operationID))
    throw new RequestError("forbidden")
  if (sessionMethods.has(request.method) && !request.sessionID) throw new RequestError("invalid_request")
  if (request.projectID && !grant.projectIDs.includes(request.projectID)) throw new RequestError("forbidden")
  if (request.method === "session.create" && !request.projectID) throw new RequestError("invalid_request")
  if (request.sessionID) {
    const project = await options.projectForSession(request.sessionID)
    if (!project || (!grant.sessionIDs.includes(request.sessionID) && !grant.projectIDs.includes(project)))
      throw new RequestError("forbidden")
    if (request.projectID && request.projectID !== project) throw new RequestError("forbidden")
  }
  const check = () => {
    const current = options.grants.get(grant.id, peer.key!)
    if (
      peer.abort.signal.aborted ||
      !current ||
      current.version !== grant.version ||
      (request.sessionID && options.sessionEnabled && !options.sessionEnabled(request.sessionID))
    )
      throw new RequestError("forbidden")
  }
  check()
  return { grant, signal: peer.abort.signal, authorize: check }
}
