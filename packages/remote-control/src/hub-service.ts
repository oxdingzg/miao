export * as HubService from "./hub-service"

import { HubAuth } from "./hub-auth"
import { HubDirectory } from "./hub-directory"
import { ControlHub } from "./hub"
import { HubTickets } from "./hub-tickets"
import { PushRegistry } from "./push-registry"
import { PushProvider } from "./push-provider"
import { PushDispatch } from "./push-dispatch"
import { Option, Schema } from "effect"
import path from "node:path"

export type Options = HubAuth.Options & {
  bootstrap?: HubAuth.Bootstrap
  hostname?: string
  port?: number
  maxClientsPerAccount?: number
  webDirectory?: string
  pushRegistrations?: boolean
  pushProvider?: PushProvider.Options
}
const Registration = Schema.Struct({ hostID: Schema.String, name: Schema.String, publicKey: Schema.String })
const decodeRegistration = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Registration)))
const TicketRequest = Schema.Struct({ hostID: Schema.String, runtimeID: Schema.String })
const decodeTicket = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(TicketRequest)))
const PushRegistration = Schema.Struct({
  deviceID: Schema.String,
  token: Schema.String,
  environment: Schema.Literals(["sandbox", "production"]),
})
const decodePush = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(PushRegistration)))
const decodePushRevocation = Schema.decodeUnknownOption(
  Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Schema.Struct({ deviceID: Schema.String }))),
)
const PushNotice = Schema.Struct({
  deviceID: Schema.String,
  signalID: Schema.String,
  runtimeID: Schema.String,
  grantID: Schema.String,
  grantVersion: Schema.Number,
  kind: Schema.Literals(["attention", "completed"]),
  context: Schema.String,
})
const decodeNotice = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(PushNotice)))
const decodeGrant = Schema.decodeUnknownOption(
  Schema.UnknownFromJsonString.pipe(
    Schema.decodeTo(Schema.Struct({ grantID: Schema.String, grantVersion: Schema.Number })),
  ),
)

/** Authenticated directory/control plane and opaque relay share one origin and listener. */
export async function listen(options: Options) {
  if (options.pushProvider && !options.pushRegistrations) throw new Error("Push delivery requires registration storage")
  const assets = new Map<string, { content: ArrayBuffer; type: string }>()
  if (options.webDirectory) {
    for (const asset of [
      { route: "/", file: "index.html", type: "text/html; charset=utf-8" },
      { route: "/control.js", file: "control.js", type: "text/javascript; charset=utf-8" },
      { route: "/control.css", file: "control.css", type: "text/css; charset=utf-8" },
    ]) {
      const file = Bun.file(path.join(options.webDirectory, asset.file))
      if (!(await file.exists()) || file.size > 8 * 1024 * 1024) throw new Error("Remote web assets unavailable")
      assets.set(asset.route, { content: await file.arrayBuffer(), type: asset.type })
    }
  }
  if (options.migrate) HubDirectory.migrate(options.database)
  const directory = HubDirectory.open(options.database)
  const identity = await HubAuth.create({ ...options, migrate: options.migrate === true })
  if (options.pushRegistrations && options.migrate) PushRegistry.migrate(options.database)
  const push = options.pushRegistrations ? PushRegistry.open(options.database) : undefined
  if (options.pushProvider && options.migrate)
    options.database.exec(`CREATE TABLE IF NOT EXISTS hub_push_revocation (
      host_id TEXT NOT NULL, grant_id TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY (host_id, grant_id)
    )`)
  const revoked = options.pushProvider
    ? options.database.query<{ version: number }, [string, string]>(
        "SELECT version FROM hub_push_revocation WHERE host_id = ? AND grant_id = ?",
      )
    : undefined
  const provider = options.pushProvider ? await PushProvider.create(options.pushProvider) : undefined
  // Never expose host credentials in the ciphertext lookup response.
  const admissions = new Map<string, { token: string; until: number }>()
  const dispatch =
    provider && push && options.pushProvider
      ? PushDispatch.make({
          registry: push,
          provider,
          environment: options.pushProvider.environment,
          authorized: (notice) => {
            const admission = admissions.get(notice.signalID)
            return (
              !!admission &&
              admission.until > Date.now() &&
              directory.authenticate(notice.hostID, admission.token) === notice.accountID &&
              (revoked!.get(notice.hostID, notice.grantID)?.version ?? 0) < notice.grantVersion &&
              server
                .connectedHosts()
                .some(
                  (host) =>
                    host.hostID === notice.hostID &&
                    host.accountID === notice.accountID &&
                    host.runtimeID === notice.runtimeID,
                )
            )
          },
        })
      : undefined
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
  const tickets = HubTickets.make()
  const server = ControlHub.listen({
    hostname: options.hostname,
    port: options.port,
    maxClientsPerAccount: options.maxClientsPerAccount,
    origins: new Set([new URL(options.baseURL).origin]),
    access: {
      fetch: async (request, peerIP) => {
        const url = new URL(request.url)
        const asset = assets.get(url.pathname)
        if (asset && request.method === "GET")
          return new Response(asset.content, {
            headers: {
              "content-type": asset.type,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
              "content-security-policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            },
          })
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
          if (url.pathname === "/api/auth/sign-out" && response.ok) push?.prune()
          response.headers.set("cache-control", "no-store")
          return response
        }
        const sender = /^\/api\/hub\/hosts\/([A-Za-z0-9_-]{16,128})\/push\/(send|revoke)$/.exec(url.pathname)
        if (sender && dispatch && request.method === "POST") {
          const authorization = request.headers.get("authorization") ?? ""
          const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
          const accountID = directory.authenticate(sender[1]!, token)
          if (!accountID) return error("unauthorized", 401)
          const text = await boundedPushBody(request, 8192)
          if (text === undefined) return error("invalid_push_request", 400)
          if (directory.authenticate(sender[1]!, token) !== accountID) return error("unauthorized", 401)
          if (sender[2] === "revoke") {
            const body = decodeGrant(text)
            if (
              Option.isNone(body) ||
              !/^[A-Za-z0-9_-]{16,128}$/.test(body.value.grantID) ||
              !Number.isSafeInteger(body.value.grantVersion) ||
              body.value.grantVersion < 1
            )
              return error("invalid_push_request", 400)
            if (
              !revoked!.get(sender[1]!, body.value.grantID) &&
              options.database
                .query<
                  { count: number },
                  [string]
                >("SELECT count(*) AS count FROM hub_push_revocation WHERE host_id = ?")
                .get(sender[1]!)!.count >= 1024
            )
              return error("push_revocation_limit", 429)
            options.database
              .query(
                `INSERT INTO hub_push_revocation (host_id, grant_id, version) VALUES (?, ?, ?)
              ON CONFLICT (host_id, grant_id) DO UPDATE SET version = max(version, excluded.version)`,
              )
              .run(sender[1]!, body.value.grantID, body.value.grantVersion)
            dispatch.revoke(sender[1]!, body.value.grantID)
            return Response.json({ revoked: true }, noStore)
          }
          const body = decodeNotice(text)
          if (Option.isNone(body)) return error("invalid_push_request", 400)
          for (const [id, admission] of admissions) if (admission.until <= Date.now()) admissions.delete(id)
          const existing = admissions.get(body.value.signalID)
          if (existing && existing.token !== token) return error("push_conflict", 409)
          if (!existing && admissions.size >= 1024) return error("push_limit", 429)
          if (!existing) admissions.set(body.value.signalID, { token, until: Date.now() + 10 * 60_000 })
          const result = await dispatch.send({ ...body.value, hostID: sender[1]!, accountID }).catch(() => undefined)
          return result ? Response.json(result, noStore) : error("invalid_push_request", 400)
        }
        const authenticated = await principal(request)
        if (!authenticated || !identity.active(authenticated)) return error("unauthorized", 401)
        if (url.pathname === "/api/hub/version" && request.method === "GET")
          return Response.json(
            {
              protocol: 1,
              capabilities: [
                "directory",
                "account-auth",
                "opaque-relay",
                "browser-tickets",
                ...(push ? ["push-registration"] : []),
                ...(dispatch ? ["push-delivery"] : []),
              ],
            },
            noStore,
          )
        if (push && url.pathname === "/api/hub/push/register" && request.method === "POST") {
          const text = await boundedPushBody(request)
          if (text === undefined) return error("invalid_push_registration", 400)
          const body = decodePush(text)
          if (Option.isNone(body)) return error("invalid_push_registration", 400)
          if (!identity.active(authenticated)) return error("unauthorized", 401)
          push.prune()
          const registered = await push
            .register(authenticated, body.value, () => identity.active(authenticated))
            .catch(() => undefined)
          return registered ? Response.json(registered, noStore) : error("push_registration_rejected", 409)
        }
        if (push && url.pathname === "/api/hub/push/revoke" && request.method === "POST") {
          const text = await boundedPushBody(request)
          if (text === undefined) return error("invalid_push_registration", 400)
          const body = decodePushRevocation(text)
          if (Option.isNone(body)) return error("invalid_push_registration", 400)
          if (!identity.active(authenticated)) return error("unauthorized", 401)
          push.revoke(authenticated, body.value.deviceID)
          return Response.json({ revoked: true }, noStore)
        }
        if (dispatch && url.pathname === "/api/hub/push/context" && request.method === "GET") {
          const notice = dispatch.get(
            authenticated.accountID,
            url.searchParams.get("deviceID") ?? "",
            url.searchParams.get("signalID") ?? "",
          )
          return notice ? Response.json(notice, noStore) : error("push_unavailable", 404)
        }
        if (url.pathname === "/api/hub/tickets" && request.method === "POST") {
          const body = decodeTicket(await request.text())
          if (Option.isNone(body)) return error("invalid_ticket_request", 400)
          if (!identity.active(authenticated)) return error("unauthorized", 401)
          if (!directory.belongs(authenticated.accountID, body.value.hostID)) return error("host_unavailable", 404)
          const host = server
            .connectedHosts()
            .find(
              (host) =>
                host.hostID === body.value.hostID &&
                host.accountID === authenticated.accountID &&
                host.runtimeID === body.value.runtimeID,
            )
          if (!host) return error("runtime_unavailable", 503)
          const issued = tickets.issue(authenticated, host.hostID, host.runtimeID)
          return issued ? Response.json(issued, noStore) : error("ticket_limit", 429)
        }
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
        const protocols = request.headers.get("sec-websocket-protocol")
        if (protocols) {
          if (request.headers.has("authorization") || request.headers.get("origin") !== new URL(options.baseURL).origin)
            return undefined
          const offered = protocols.split(",").map((value) => value.trim())
          if (
            offered.length !== 2 ||
            offered[0] !== "miao.control.v1" ||
            !/^miao\.ticket\.[A-Za-z0-9_-]{43}$/.test(offered[1]!)
          )
            return undefined
          const ticket = tickets.consume(offered[1]!.slice("miao.ticket.".length), hostID)
          if (!ticket || !identity.active(ticket.principal) || !directory.belongs(ticket.principal.accountID, hostID))
            return undefined
          return {
            accountID: ticket.principal.accountID,
            runtimeID: ticket.runtimeID,
            protocol: "miao.control.v1",
            valid: () => identity.active(ticket.principal) && directory.belongs(ticket.principal.accountID, hostID),
          }
        }
        const authenticated = await principal(request)
        if (!authenticated || !directory.belongs(authenticated.accountID, hostID)) return undefined
        return {
          accountID: authenticated.accountID,
          valid: () => identity.active(authenticated) && directory.belongs(authenticated.accountID, hostID),
        }
      },
    },
  })
  return {
    ...server,
    stop: async () => {
      tickets.clear()
      dispatch?.stop()
      admissions.clear()
      provider?.stop()
      await server.stop()
    },
  }
}

const noStore = { headers: { "cache-control": "no-store" } }
function error(code: string, status: number) {
  return Response.json({ code }, { ...noStore, status })
}

async function boundedPushBody(request: Request, limit = 4096) {
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  const size = { value: 0, expired: false }
  const timer = setTimeout(() => {
    size.expired = true
    void reader.cancel().catch(() => undefined)
  }, 5000)
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size.value += chunk.value.byteLength
      if (size.value > limit) {
        await reader.cancel()
        return undefined
      }
      chunks.push(chunk.value)
    }
    if (size.expired) return undefined
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}
