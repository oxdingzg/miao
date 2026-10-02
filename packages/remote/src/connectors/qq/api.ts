// QQ bot OpenAPI client: app access tokens, the gateway address, and C2C
// messages. Follows the official Node SDK @tencent-connect/qqbot-nodejs 1.0.4
// (MIT; api/token.ts, api/api-client.ts, api/messages.ts) and the open platform
// docs. Since 2026-08-10 the docs name api.bot.qq.com for everything; community
// clients still use bots.qq.com (token) and api.sgroup.qq.com (OpenAPI), so when
// no host is configured the old hosts are tried after the new one fails.

export const Hosts = {
  api: "https://api.bot.qq.com",
  legacyToken: "https://bots.qq.com",
  legacyApi: "https://api.sgroup.qq.com",
  portal: "https://q.qq.com",
} as const

export const ErrorCode = {
  /** The user turned off proactive messages from this bot. */
  Rejected: 40054013,
  /** Proactive message rate limit. */
  Throttled: 40034100,
  /** msg_id of a passive reply expired. */
  ReplyExpired: 40034005,
  /** msg_id invalid or not ours. */
  ReplyInvalid: 40034024,
  /** Passive reply window or count exceeded. */
  ReplyExhausted: 40034128,
} as const

/** Errors that mean the bot may not send markdown; plain text still works. */
export const MarkdownErrors = new Set([40034008, 40034009, 40034010, 40034011, 40034124, 40034127])

export type Credentials = { readonly appId: string; readonly secret: string }

export type SendBody = Readonly<Record<string, unknown>>

export type SendOutcome =
  | { readonly ok: true; readonly id?: string }
  | { readonly ok: false; readonly status: number; readonly code?: number; readonly message: string }

export class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message)
  }
}

export function createQQApi(input: {
  readonly credentials: Credentials
  /** A configured host is used as is and never falls back to another one. */
  readonly api?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly log?: (message: string) => void
}) {
  const request = input.fetch ?? fetch
  const now = input.now ?? Date.now
  const log = input.log ?? (() => undefined)
  const configured = input.api?.replace(/\/+$/, "")
  const hosts = {
    token: configured ? [configured] : [Hosts.api, Hosts.legacyToken],
    api: configured ? [configured] : [Hosts.api, Hosts.legacyApi],
  }
  // Once an older host answered, keep using it instead of failing over on every call.
  const sticky = { token: 0, api: 0 }
  const cache = { token: undefined as { value: string; fetchedAt: number; expiresAt: number } | undefined }
  const pending = { token: undefined as Promise<string> | undefined }

  return { token, invalidate, gatewayUrl, send, hosts }

  /** A valid access token, refreshed min(5 minutes, a third of its lifetime) before it expires. */
  function token() {
    const cached = cache.token
    if (cached && now() < cached.expiresAt - Math.min(5 * 60_000, (cached.expiresAt - cached.fetchedAt) / 3))
      return Promise.resolve(cached.value)
    pending.token ??= fetchToken().finally(() => {
      pending.token = undefined
    })
    return pending.token
  }

  function invalidate() {
    cache.token = undefined
  }

  async function fetchToken() {
    const response = await failover("token", "/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: input.credentials.appId, clientSecret: input.credentials.secret }),
    })
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: number | string
      code?: number
      message?: string
    }
    if (!response.ok || !body.access_token)
      throw new QQApiError(
        `getAppAccessToken failed: HTTP ${response.status} ${body.message ?? ""}`.trim(),
        response.status,
        body.code,
      )
    const seconds = Number(body.expires_in ?? 7200)
    cache.token = {
      value: body.access_token,
      fetchedAt: now(),
      expiresAt: now() + (Number.isFinite(seconds) ? seconds : 7200) * 1000,
    }
    return body.access_token
  }

  async function gatewayUrl() {
    const response = await authorized("GET", "/gateway")
    const body = (await response.json().catch(() => ({}))) as { url?: string; message?: string }
    if (!response.ok || !body.url)
      throw new QQApiError(`gateway failed: HTTP ${response.status} ${body.message ?? ""}`.trim(), response.status)
    return body.url
  }

  async function send(openid: string, body: SendBody): Promise<SendOutcome> {
    const response = await authorized("POST", `/v2/users/${encodeURIComponent(openid)}/messages`, body).catch(
      (error: unknown) => error,
    )
    if (!(response instanceof Response))
      return { ok: false, status: 0, message: response instanceof Error ? response.message : String(response) }
    const value: unknown = await response.json().catch(() => ({}))
    const parsed = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
    const code = typeof parsed.err_code === "number" ? parsed.err_code : (parsed.code as number | undefined)
    if (response.ok && (code === undefined || code === 0))
      return { ok: true, id: typeof parsed.id === "string" ? parsed.id : undefined }
    return {
      ok: false,
      status: response.status,
      code: typeof code === "number" ? code : undefined,
      message: typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`,
    }
  }

  async function authorized(method: string, path: string, body?: SendBody) {
    const call = async () =>
      failover("api", path, {
        method,
        headers: { Authorization: `QQBot ${await token()}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    const response = await call()
    if (response.status !== 401) return response
    // A token revoked early (for example by a new login elsewhere) is fetched again once.
    invalidate()
    return call()
  }

  async function failover(kind: "token" | "api", path: string, init: RequestInit): Promise<Response> {
    const list = hosts[kind]
    const attempt = async (index: number): Promise<Response> => {
      const host = list[index]
      const result = await request(`${host}${path}`, { ...init, signal: AbortSignal.timeout(15_000) }).catch(
        (error: unknown) => error,
      )
      const unreachable = !(result instanceof Response) || result.status === 404 || result.status >= 502
      if (unreachable && index + 1 < list.length) {
        log(
          `qq: ${host}${path} unavailable (${result instanceof Response ? result.status : String(result)}); trying ${list[index + 1]}`,
        )
        const next = await attempt(index + 1)
        if (next.ok) sticky[kind] = index + 1
        return next
      }
      if (result instanceof Response) return result
      throw result instanceof Error ? result : new Error(String(result))
    }
    return attempt(sticky[kind])
  }
}

export type QQApi = ReturnType<typeof createQQApi>
