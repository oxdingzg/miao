export * as ControlHub from "./hub"

import { createHash, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import type { ServerWebSocket } from "bun"

const identifier = /^[A-Za-z0-9_-]{16,128}$/
const ciphertext = /^[A-Za-z0-9+/]+={0,2}$/
const Frame = Schema.Struct({
  type: Schema.Literal("frame"),
  connectionID: Schema.String.check(Schema.isPattern(identifier)),
  payload: Schema.String.check(Schema.isPattern(ciphertext)),
})
const decodeFrame = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Frame)))

type Socket = ServerWebSocket<Peer>
type Host = { runtimeID: string; socket?: Socket; clients: Map<string, Client> }
type Client = { connectionID: string; socket?: Socket }
type Peer =
  | { role: "host"; hostID: string; host: Host }
  | { role: "client"; hostID: string; host: Host; client: Client }

export type Options = {
  readonly hosts: ReadonlyMap<string, string>
  readonly hostname?: string
  readonly port?: number
  readonly origins?: ReadonlySet<string>
  readonly maxClientsPerHost?: number
  readonly maxFrameBytes?: number
  readonly maxBufferedBytes?: number
}

/** An opaque forwarder. Grants and application requests are verified by the Agent. */
export function listen(options: Options) {
  const credentials = new Map(
    [...options.hosts].map(([id, token]) => {
      if (!identifier.test(id) || token.length < 32) throw new Error("Invalid Hub host credentials")
      return [id, createHash("sha256").update(token).digest()] as const
    }),
  )
  const hosts = new Map<string, Host>()
  const sockets = new Set<Socket>()
  const limits = {
    clients: options.maxClientsPerHost ?? 64,
    frame: options.maxFrameBytes ?? 256 * 1024,
    buffer: options.maxBufferedBytes ?? 1024 * 1024,
  }
  function send(socket: Socket | undefined, message: string) {
    if (!socket) return false
    if (socket.getBufferedAmount() + Buffer.byteLength(message) > limits.buffer) {
      socket.close(1013, "Reconnect and resynchronize")
      return false
    }
    return socket.send(message) !== 0
  }
  const server = Bun.serve<Peer>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4600,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health" && request.method === "GET")
        return Response.json({ ok: true, protocol: 1 }, { headers: { "cache-control": "no-store" } })
      if (request.method !== "GET" || (url.pathname !== "/v1/host" && url.pathname !== "/v1/client"))
        return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && !options.origins?.has(origin)) return new Response("Origin denied", { status: 403 })
      const hostID = url.searchParams.get("hostID") ?? ""
      if (!identifier.test(hostID)) return new Response("Invalid host identity", { status: 400 })
      if (url.pathname === "/v1/host") {
        const expected = credentials.get(hostID)
        const authorization = request.headers.get("authorization") ?? ""
        if (
          !expected ||
          !authorization.startsWith("Bearer ") ||
          !timingSafeEqual(expected, createHash("sha256").update(authorization.slice(7)).digest())
        )
          return new Response("Unauthorized", { status: 401 })
        const runtimeID = url.searchParams.get("runtimeID") ?? ""
        if (!identifier.test(runtimeID)) return new Response("Invalid runtime identity", { status: 400 })
        if (hosts.has(hostID)) return new Response("Host already connected", { status: 409 })
        const host: Host = { runtimeID, clients: new Map() }
        if (!server.upgrade(request, { data: { role: "host", hostID, host } }))
          return new Response("WebSocket required", { status: 426 })
        hosts.set(hostID, host)
        return
      }
      const host = hosts.get(hostID)
      if (!host?.socket) return new Response("Host unavailable", { status: 503 })
      if (host.clients.size >= limits.clients) return new Response("Host connection limit", { status: 429 })
      const client: Client = { connectionID: crypto.randomUUID() }
      if (!server.upgrade(request, { data: { role: "client", hostID, host, client } }))
        return new Response("WebSocket required", { status: 426 })
      host.clients.set(client.connectionID, client)
    },
    websocket: {
      maxPayloadLength: limits.frame,
      backpressureLimit: limits.buffer,
      closeOnBackpressureLimit: true,
      idleTimeout: 90,
      sendPings: true,
      open(socket) {
        sockets.add(socket)
        const peer = socket.data
        if (peer.role === "host") {
          peer.host.socket = socket
          return
        }
        if (hosts.get(peer.hostID) !== peer.host || !peer.host.socket) {
          socket.close(1012, "Runtime disconnected")
          return
        }
        peer.client.socket = socket
        send(peer.host.socket, JSON.stringify({ type: "connected", connectionID: peer.client.connectionID }))
      },
      message(socket, message) {
        const peer = socket.data
        if (typeof message !== "string") return socket.close(1003, "Text envelope required")
        if (peer.role === "client") {
          if (!ciphertext.test(message)) return socket.close(1008, "Invalid ciphertext envelope")
          if (
            !send(
              peer.host.socket,
              JSON.stringify({ type: "frame", connectionID: peer.client.connectionID, payload: message }),
            )
          )
            socket.close(1013, "Runtime unavailable")
          return
        }
        const frame = decodeFrame(message)
        if (Option.isNone(frame)) return socket.close(1008, "Invalid routing envelope")
        const client = peer.host.clients.get(frame.value.connectionID)
        if (client) send(client.socket, frame.value.payload)
      },
      close(socket) {
        sockets.delete(socket)
        const peer = socket.data
        if (peer.role === "client") {
          peer.host.clients.delete(peer.client.connectionID)
          send(peer.host.socket, JSON.stringify({ type: "disconnected", connectionID: peer.client.connectionID }))
          return
        }
        if (hosts.get(peer.hostID) !== peer.host) return
        hosts.delete(peer.hostID)
        peer.host.clients.forEach((client) => client.socket?.close(1012, "Runtime disconnected"))
        peer.host.clients.clear()
      },
    },
  })
  return {
    hostname: server.hostname,
    port: server.port,
    stop: async () => {
      sockets.forEach((socket) => socket.terminate())
      // Bun 1.3.14 can leave its drain promise pending after a server-side
      // WebSocket close (oven-sh/bun#36223). Stop accepts immediately, and
      // bound the drain wait so shutdown cannot hang on that counter.
      server.unref()
      const timeout = Promise.withResolvers<void>()
      const timer = setTimeout(() => timeout.resolve(), 1000)
      await Promise.race([server.stop(true), timeout.promise]).finally(() => clearTimeout(timer))
    },
  }
}
