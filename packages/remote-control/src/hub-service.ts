export * as HubService from "./hub-service"

import { HubAuth } from "./hub-auth"
import { HubDirectory } from "./hub-directory"
import { ControlHub } from "./hub"
import { Option, Schema } from "effect"

export type Options = HubAuth.Options & {
  bootstrap?: HubAuth.Bootstrap
  hostname?: string
  port?: number
  maxClientsPerAccount?: number
}
const Registration = Schema.Struct({ hostID: Schema.String, name: Schema.String, publicKey: Schema.String })
const decodeRegistration = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Registration)))

/** Authenticated directory/control plane and opaque relay share one origin and listener. */
export async function listen(options: Options) {
  if (options.migrate) HubDirectory.migrate(options.database)
  const directory = HubDirectory.open(options.database)
  const identity = await HubAuth.create({ ...options, migrate: options.migrate === true })
  if (
    options.bootstrap &&
    options.database.query<{ count: number }, []>('SELECT count(*) AS count FROM "user"').get()!.count === 0
  )
    await identity.bootstrap(options.bootstrap)
  if (options.database.query<{ count: number }, []>('SELECT count(*) AS count FROM "user"').get()!.count === 0)
    throw new Error("Private Hub administrator initialization required")
  const principal = (request: Request) => {
    const authorization = request.headers.get("authorization") ?? ""
    if (!authorization.startsWith("Bearer ")) return Promise.resolve(undefined)
    return identity.verify(authorization.slice(7)).catch(() => undefined)
  }
  const server = ControlHub.listen({
    hostname: options.hostname,
    port: options.port,
    maxClientsPerAccount: options.maxClientsPerAccount,
    origins: new Set([new URL(options.baseURL).origin]),
    access: {
      fetch: async (request, peerIP) => {
        const url = new URL(request.url)
        if (!url.pathname.startsWith("/api/")) return undefined
        const origin = request.headers.get("origin")
        if (origin && origin !== new URL(options.baseURL).origin) return error("origin_denied", 403)
        if (url.pathname.startsWith("/api/auth/")) {
          const routes: Record<string, string> = {
            "/api/auth/sign-in/email": "POST",
            "/api/auth/sign-out": "POST",
            "/api/auth/token": "GET",
            "/api/auth/get-session": "GET",
          }
          if (routes[url.pathname] !== request.method) return error("not_found", 404)
          // Use the socket peer, never client-supplied forwarding headers, for authentication throttling.
          const headers = new Headers(request.headers)
          headers.delete("x-miao-peer-ip")
          if (peerIP) headers.set("x-miao-peer-ip", peerIP)
          const response = await identity.auth.handler(new Request(request, { headers }))
          response.headers.set("cache-control", "no-store")
          return response
        }
        const authenticated = await principal(request)
        if (!authenticated || !identity.active(authenticated)) return error("unauthorized", 401)
        if (url.pathname === "/api/hub/version" && request.method === "GET")
          return Response.json({ protocol: 1, capabilities: ["directory", "account-auth", "opaque-relay"] }, noStore)
        if (url.pathname === "/api/hub/hosts" && request.method === "GET") {
          const connected = new Map(
            server
              .connectedHosts()
              .filter((host) => host.accountID === authenticated.accountID)
              .map((host) => [host.hostID, host.runtimeID]),
          )
          return Response.json(
            {
              data: directory.list(authenticated.accountID).map((host) => ({
                ...host,
                online: host.revokedAt === null && connected.has(host.hostID),
                runtimeID: host.revokedAt === null ? (connected.get(host.hostID) ?? null) : null,
              })),
            },
            noStore,
          )
        }
        if (url.pathname === "/api/hub/hosts" && request.method === "POST") {
          const body = decodeRegistration(await request.text())
          if (Option.isNone(body)) return error("invalid_registration", 400)
          const registered = await directory
            .register(authenticated.accountID, body.value, () => identity.active(authenticated))
            .catch(() => undefined)
          return registered
            ? Response.json(registered, { ...noStore, status: 201 })
            : error("registration_rejected", 409)
        }
        const host = /^\/api\/hub\/hosts\/([A-Za-z0-9_-]{16,128})\/(revoke|rotate)$/.exec(url.pathname)
        if (!host || request.method !== "POST") return error("not_found", 404)
        if (!identity.active(authenticated)) return error("unauthorized", 401)
        if (host[2] === "revoke")
          return directory.revoke(authenticated.accountID, host[1]!)
            ? Response.json({ revoked: true }, noStore)
            : error("host_unavailable", 404)
        const token = await Promise.resolve()
          .then(() =>
            identity.active(authenticated) ? directory.rotate(authenticated.accountID, host[1]!) : undefined,
          )
          .catch(() => undefined)
        return token ? Response.json({ token }, noStore) : error("host_unavailable", 404)
      },
      host: async (request, hostID) => {
        const authorization = request.headers.get("authorization") ?? ""
        if (!authorization.startsWith("Bearer ")) return undefined
        const token = authorization.slice(7)
        const accountID = directory.authenticate(hostID, token)
        return accountID ? { accountID, valid: () => directory.authenticate(hostID, token) === accountID } : undefined
      },
      client: async (request, hostID) => {
        const authenticated = await principal(request)
        if (!authenticated || !directory.belongs(authenticated.accountID, hostID)) return undefined
        return {
          accountID: authenticated.accountID,
          valid: () => identity.active(authenticated) && directory.belongs(authenticated.accountID, hostID),
        }
      },
    },
  })
  return server
}

const noStore = { headers: { "cache-control": "no-store" } }
function error(code: string, status: number) {
  return Response.json({ code }, { ...noStore, status })
}
