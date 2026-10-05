export * as HubSetup from "./hub-setup"

import type { RemoteAccess } from "@miao/schema/remote-access"

export type Runtime = {
  get(): Promise<RemoteAccess.Status>
  configure(configuration: RemoteAccess.Configuration): Promise<RemoteAccess.Status>
}

/** Account credentials stay in memory; only the host-scoped relay token reaches the Runtime. */
export async function connect(input: {
  hubURL: string
  email: string
  password: string
  name: string
  runtime: Runtime
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  allowLoopbackHTTP?: boolean
}): Promise<RemoteAccess.Status> {
  const url = new URL(input.hubURL)
  const loopback = input.allowLoopbackHTTP && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use the HTTPS origin of your relay")
  const origin = url.origin
  const host = await input.runtime.get()
  if (!host.hostID || !host.hostPublicKey) throw new Error("Runtime host identity is unavailable")
  const send = input.fetch ?? fetch
  async function request(path: string, token?: string, body?: unknown) {
    return send(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
  }
  let login: string | undefined
  try {
    const signedIn = await request("/api/auth/sign-in/email", undefined, { email: input.email, password: input.password })
    login = signedIn.headers.get("set-auth-token") ?? undefined
    if (!signedIn.ok || !login) throw new Error("Relay login failed")
    const accessResponse = await request("/api/auth/token", login)
    if (!accessResponse.ok) throw new Error("Relay login failed")
    const access: unknown = await accessResponse.json()
    if (!isToken(access)) throw new Error("Relay login failed")
    const registered = await request("/api/hub/hosts", access.token, {
      hostID: host.hostID, publicKey: host.hostPublicKey, name: input.name,
    })
    if (!registered.ok) throw new Error("Host registration failed; check the relay host directory")
    const registration: unknown = await registered.json()
    if (!isToken(registration) || !/^[A-Za-z0-9_-]{32,256}$/.test(registration.token))
      throw new Error("Invalid host registration response")
    return await input.runtime.configure({ hubURL: origin, hostToken: registration.token })
  } catch {
    // Never forward HTTP bodies, provider errors, or Runtime SDK request details containing credentials.
    throw new Error("Relay setup could not be confirmed; check the Runtime status and relay host directory")
  } finally {
    if (login) await request("/api/auth/sign-out", login, {}).catch(() => undefined)
  }
}

function isToken(value: unknown): value is { token: string } {
  return typeof value === "object" && value !== null && "token" in value && typeof value.token === "string"
}
