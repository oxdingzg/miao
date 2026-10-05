export * as ControlHub from "./hub"

import { createHash, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import type { ServerWebSocket } from "bun"

const identifier = /^[A-Za-z0-9_-]{16,128}$/
const ciphertext = /^[A-Za-z0-9+/_-]+={0,2}$/
const Frame = Schema.Struct({
  type: Schema.Literal("frame"),
  connectionID: Schema.String.check(Schema.isPattern(identifier)),
  payload: Schema.String.check(Schema.isPattern(ciphertext)),
})
const Close = Schema.Struct({
  type: Schema.Literal("close"),
  connectionID: Schema.String.check(Schema.isPattern(identifier)),
})
const decodeFrame = Schema.decodeUnknownOption(
  Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Union([Frame, Close]))),
)

type Socket = ServerWebSocket<Peer>
type Host = { runtimeID: string; accountID?: string; socket?: Socket; clients: Map<string, Client> }
type Client = { connectionID: string; socket?: Socket }
export type Authorization = { accountID: string; valid: () => boolean; runtimeID?: string; protocol?: string }
type Peer =
  | { role: "host"; hostID: string; host: Host; authorization?: Authorization }
  | { role: "client"; hostID: string; host: Host; client: Client; authorization?: Authorization }

export type Options = {
  readonly hosts?: ReadonlyMap<string, string>
  readonly access?: {
    fetch: (request: Request, peerIP?: string) => Promise<Response | undefined>
    host: (request: Request, hostID: string, runtimeID: string) => Promise<Authorization | undefined>
    client: (request: Request, hostID: string) => Promise<Authorization | undefined>
  }
  readonly hostname?: string
  readonly port?: number
  readonly origins?: ReadonlySet<string>
  readonly maxClientsPerHost?: number
  readonly maxClientsPerAccount?: number
  readonly maxFrameBytes?: number
  readonly maxBufferedBytes?: number
}

/** An opaque forwarder. Grants and application requests are verified by the Agent. */
export function listen(options: Options) {
  const credentials = new Map(
    [...(options.hosts ?? [])].map(([id, token]) => {
      if (!identifier.test(id) || token.length < 32) throw new Error("Invalid Hub host credentials")
      return [id, createHash("sha256").update(token).digest()] as const
    }),
  )
  const hosts = new Map<string, Host>()
  const sockets = new Set<Socket>()
  const limits = {
    clients: options.maxClientsPerHost ?? 64,
    accountClients: options.maxClientsPerAccount ?? 64,
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
    maxRequestBodySize: 16 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/health" && request.method === "GET")
        return Response.json({ ok: true, protocol: 1 }, { headers: { "cache-control": "no-store" } })
      const handled = await options.access?.fetch(request, server.requestIP(request)?.address)
      if (handled) return handled
      if (request.method !== "GET" || (url.pathname !== "/v1/host" && url.pathname !== "/v1/client"))
        return new Response("Not found", { status: 404 })
      const origin = request.headers.get("origin")
      if (origin && !options.origins?.has(origin)) return new Response("Origin denied", { status: 403 })
      const hostID = url.searchParams.get("hostID") ?? ""
      if (!identifier.test(hostID)) return new Response("Invalid host identity", { status: 400 })
      if (url.pathname === "/v1/host") {
        const runtimeID = url.searchParams.get("runtimeID") ?? ""
        if (!identifier.test(runtimeID)) return new Response("Invalid runtime identity", { status: 400 })
        const authorization = await options.access?.host(request, hostID, runtimeID)
        if (options.access && !authorization?.valid()) return new Response("Unauthorized", { status: 401 })
        if (!options.access) {
          const expected = credentials.get(hostID)
          const bearer = request.headers.get("authorization") ?? ""
          if (
            !expected ||
            !bearer.startsWith("Bearer ") ||
            !timingSafeEqual(expected, createHash("sha256").update(bearer.slice(7)).digest())
          )
            return new Response("Unauthorized", { status: 401 })
        }
        if (hosts.has(hostID)) return new Response("Host already connected", { status: 409 })
        const host: Host = { runtimeID, accountID: authorization?.accountID, clients: new Map() }
        if (!server.upgrade(request, { data: { role: "host", hostID, host, authorization } }))
          return new Response("WebSocket required", { status: 426 })
        hosts.set(hostID, host)
        return
      }
      const authorization = await options.access?.client(request, hostID)
      if (options.access && !authorization?.valid()) return new Response("Unauthorized", { status: 401 })
      if (
        authorization &&
        [...hosts.values()].reduce(
          (count, host) => count + (host.accountID === authorization.accountID ? host.clients.size : 0),
          0,
        ) >= limits.accountClients
      )
        return new Response("Account connection limit", { status: 429 })
      const host = hosts.get(hostID)
      if (options.access && host && host.accountID !== authorization?.accountID)
        return new Response("Unauthorized", { status: 401 })
      if (!host?.socket || (host.socket.data.authorization && !host.socket.data.authorization.valid()))
        return new Response("Host unavailable", { status: 503 })
      if (authorization?.runtimeID && authorization.runtimeID !== host.runtimeID)
        return new Response("Runtime changed", { status: 409 })
      if (host.clients.size >= limits.clients) return new Response("Host connection limit", { status: 429 })
      const client: Client = { connectionID: crypto.randomUUID() }
      if (
        !server.upgrade(request, {
          data: { role: "client", hostID, host, client, authorization },
          ...(authorization?.protocol ? { headers: { "sec-websocket-protocol": authorization.protocol } } : {}),
        })
      )
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
        if (peer.authorization && !peer.authorization.valid()) return socket.close(1008, "Hub authorization expired")
        if (peer.role === "host") {
          peer.host.socket = socket
          return
        }
        if (hosts.get(peer.hostID) !== peer.host || !peer.host.socket) {
          socket.close(1012, "Runtime disconnected")
          return
        }
        if (peer.host.socket.data.authorization && !peer.host.socket.data.authorization.valid())
          return socket.close(1008, "Hub host authorization expired")
        peer.client.socket = socket
        send(peer.host.socket, JSON.stringify({ type: "connected", connectionID: peer.client.connectionID }))
      },
      message(socket, message) {
        const peer = socket.data
        if (peer.authorization && !peer.authorization.valid()) return socket.close(1008, "Hub authorization expired")
        if (peer.host.socket?.data.authorization && !peer.host.socket.data.authorization.valid())
          return socket.close(1008, "Hub host authorization expired")
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
        if (frame.value.type === "close") {
          client?.socket?.close(1008, "Agent rejected connection")
          return
        }
        if (client?.socket?.data.authorization && !client.socket.data.authorization.valid())
          return client.socket.close(1008, "Hub authorization expired")
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
  const expiration = options.access
    ? setInterval(() => {
        sockets.forEach((socket) => {
          if (socket.data.authorization && !socket.data.authorization.valid())
            socket.close(1008, "Hub authorization expired")
        })
      }, 1000)
    : undefined
  expiration?.unref()
  return {
    connectedHosts: () =>
      [...hosts]
        .filter(
          ([, host]) => host.socket && (!host.socket.data.authorization || host.socket.data.authorization.valid()),
        )
        .map(([hostID, host]) => ({ hostID, runtimeID: host.runtimeID, accountID: host.accountID })),
    hostname: server.hostname,
    port: server.port,
    stop: async () => {
      clearInterval(expiration)
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
