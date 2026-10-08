export * as HubSetup from "./hub-setup"

import type { RemoteAccess } from "@miao/schema/remote-access"

export type Runtime = {
  get(): Promise<RemoteAccess.Status>
  configure(configuration: RemoteAccess.Configuration): Promise<RemoteAccess.Status>
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>
type Request = (path: string, token?: string, body?: unknown) => Promise<Response>
type Host = { readonly hostID: string; readonly hostPublicKey: string }

/** The social providers an OAuth-capable relay advertises; empty for a password-only relay. */
export type Providers = { readonly providers: ReadonlyArray<string> }

/**
 * Discovers how accounts sign in to the relay. A self-hosted relay that only
 * enables email/password has no providers endpoint, which reads as no social
 * providers and keeps the caller on the password flow.
 */
export async function providers(input: {
  hubURL: string
  allowLoopbackHTTP?: boolean
  fetch?: FetchLike
}): Promise<Providers> {
  const origin = hubOrigin(input.hubURL, input.allowLoopbackHTTP)
  const send = input.fetch ?? fetch
  const response = await send(origin + "/api/auth/providers", {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  }).catch(() => { throw new Error("Hub login methods could not be discovered; check the connection and retry") })
  if (response.status === 404) return { providers: [] }
  if (!response.ok) throw new Error("Hub login methods could not be discovered; check the connection and retry")
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null || !("providers" in body) || !Array.isArray(body.providers))
    throw new Error("Hub returned invalid login methods")
  return { providers: body.providers.filter((value): value is string => typeof value === "string") }
}

/** Account credentials stay in memory; only the host-scoped relay token reaches the Runtime. */
export async function connect(input: {
  hubURL: string
  email: string
  password: string
  name: string
  runtime: Runtime
  fetch?: FetchLike
  allowLoopbackHTTP?: boolean
}): Promise<RemoteAccess.Status> {
  const origin = hubOrigin(input.hubURL, input.allowLoopbackHTTP)
  const host = await requireHost(input.runtime)
  const request = relayRequest(origin, input.fetch ?? fetch)
  let login: string | undefined
  try {
    const signedIn = await request("/api/auth/sign-in/email", undefined, { email: input.email, password: input.password })
    login = signedIn.headers.get("set-auth-token") ?? undefined
    if (!signedIn.ok || !login) throw new Error("Relay login failed")
    const accessResponse = await request("/api/auth/token", login)
    if (!accessResponse.ok) throw new Error("Relay login failed")
    const access: unknown = await accessResponse.json()
    if (!isToken(access)) throw new Error("Relay login failed")
    return await registerHost({ origin, name: input.name, token: access.token, host, request, runtime: input.runtime })
  } catch {
    // Never forward HTTP bodies, provider errors, or Runtime SDK request details containing credentials.
    throw new Error("Relay setup could not be confirmed; check the Runtime status and relay host directory")
  } finally {
    if (login) await request("/api/auth/sign-out", login, {}).catch(() => undefined)
  }
}

/**
 * Signs in through the relay's browser flow, which is the only way into an
 * OAuth-only relay. The caller owns the browser and the redirect
 * listener: it supplies the loopback `callbackURL`, opens the authorize URL,
 * and resolves `waitForCode` with the one-time code the relay hands back.
 */
export async function connectWithOAuth(input: {
  hubURL: string
  provider: string
  name: string
  runtime: Runtime
  callbackURL: string
  open: (authorizeURL: string) => Promise<void>
  waitForCode: () => Promise<string>
  fetch?: FetchLike
  allowLoopbackHTTP?: boolean
}): Promise<RemoteAccess.Status> {
  const origin = hubOrigin(input.hubURL, input.allowLoopbackHTTP)
  const host = await requireHost(input.runtime)
  const request = relayRequest(origin, input.fetch ?? fetch)
  let authorizeURL: string
  try {
    const started = await request("/api/auth/sign-in/social", undefined, {
      provider: input.provider,
      callbackURL: input.callbackURL,
    })
    if (!started.ok) throw new Error("Relay login failed")
    const start: unknown = await started.json()
    if (!isAuthorizeStart(start)) throw new Error("Relay login failed")
    authorizeURL = start.url
  } catch {
    throw new Error("Relay setup could not be confirmed; check the Runtime status and relay host directory")
  }
  // Opening the browser is the caller's job; its failure (for example a headless
  // terminal) surfaces the URL instead of being folded into the generic error.
  await input.open(authorizeURL)
  let code: string
  try {
    code = await input.waitForCode()
  } catch {
    throw new Error("Relay authorization was not completed; try signing in again")
  }
  let token: string | undefined
  try {
    const exchanged = await request("/api/auth/exchange", undefined, { code, client: "cli" })
    if (!exchanged.ok) throw new Error("Relay login failed")
    const access: unknown = await exchanged.json()
    if (!isToken(access)) throw new Error("Relay login failed")
    token = access.token
    return await registerHost({ origin, name: input.name, token, host, request, runtime: input.runtime })
  } catch {
    throw new Error("Relay setup could not be confirmed; check the Runtime status and relay host directory")
  } finally {
    if (token) await request("/api/auth/sign-out", token, {}).catch(() => undefined)
  }
}

async function registerHost(input: {
  origin: string
  name: string
  token: string
  host: Host
  request: Request
  runtime: Runtime
}): Promise<RemoteAccess.Status> {
  const registered = await input.request("/api/hub/hosts", input.token, {
    hostID: input.host.hostID,
    publicKey: input.host.hostPublicKey,
    name: input.name,
  })
  let registration: unknown
  if (registered.status === 409) {
    const directory = await input.request("/api/hub/hosts", input.token)
    if (!directory.ok) throw new Error("Host directory unavailable")
    const listed: unknown = await directory.json()
    if (!hasMatchingHost(listed, input.host.hostID, input.host.hostPublicKey)) throw new Error("Host identity mismatch")
    const rotated = await input.request(`/api/hub/hosts/${input.host.hostID}/rotate`, input.token, {})
    if (!rotated.ok) throw new Error("Host credential rotation failed")
    registration = await rotated.json()
  } else {
    if (!registered.ok) throw new Error("Host registration failed; check the relay host directory")
    registration = await registered.json()
  }
  if (!isToken(registration) || !/^[A-Za-z0-9_-]{32,256}$/.test(registration.token))
    throw new Error("Invalid host registration response")
  return await input.runtime.configure({ hubURL: input.origin, hostToken: registration.token })
}

async function requireHost(runtime: Runtime): Promise<Host> {
  const host = await runtime.get()
  if (!host.hostID || !host.hostPublicKey) throw new Error("Runtime host identity is unavailable")
  return { hostID: host.hostID, hostPublicKey: host.hostPublicKey }
}

function hubOrigin(hubURL: string, allowLoopbackHTTP?: boolean): string {
  const url = new URL(hubURL)
  const loopback = allowLoopbackHTTP && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use the HTTPS origin of your relay")
  return url.origin
}

function relayRequest(origin: string, send: FetchLike): Request {
  return (path, token, body) =>
    send(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
}

function isToken(value: unknown): value is { token: string } {
  return typeof value === "object" && value !== null && "token" in value && typeof value.token === "string"
}

function isAuthorizeStart(value: unknown): value is { url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    value.url.startsWith("https://")
  )
}

function hasMatchingHost(value: unknown, hostID: string, publicKey: string): boolean {
  if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) return false
  return value.data.some(
    (host: unknown) =>
      typeof host === "object" &&
      host !== null &&
      "hostID" in host &&
      host.hostID === hostID &&
      "publicKey" in host &&
      host.publicKey === publicKey &&
      "revokedAt" in host &&
      host.revokedAt === null,
  )
}
