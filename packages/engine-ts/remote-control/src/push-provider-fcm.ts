export * as PushProviderFcm from "./push-provider-fcm"

import { importPKCS8, SignJWT } from "jose"

/**
 * Firebase Cloud Messaging HTTP v1 transport for the same generic wake-up hint
 * the APNs provider sends: fixed alert text plus an opaque signal identifier.
 * Session text, project paths, permission details and commands never enter the
 * payload.
 */
export type Options = {
  projectID: string
  clientEmail: string
  privateKey: string
  /** Loopback-only fixtures; production always uses Google's endpoints. */
  tokenEndpoint?: string
  messageEndpoint?: string
}
export type Signal = { token: string; signalID: string; kind: "attention" | "completed" }
export type Result =
  | { status: "accepted"; id: string }
  | { status: "rejected" | "retryable" | "unknown"; id: string }

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

export async function create(options: Options) {
  if (!/^[a-z0-9-]{6,64}$/i.test(options.projectID)) throw new Error("Invalid FCM project id")
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(options.clientEmail))
    throw new Error("Invalid FCM client email")
  const tokenURL = options.tokenEndpoint ? fixtureEndpoint(options.tokenEndpoint) + "/token" : "https://oauth2.googleapis.com/token"
  if (options.tokenEndpoint) requireLoopback(options.tokenEndpoint)
  const messageBase = options.messageEndpoint
    ? fixtureEndpoint(options.messageEndpoint) + "/v1"
    : "https://fcm.googleapis.com/v1"
  if (options.messageEndpoint) requireLoopback(options.messageEndpoint)
  const endpoint = `${messageBase}/projects/${options.projectID}/messages:send`
  const key = await importPKCS8(options.privateKey, "RS256")
  const state: { token?: { value: Promise<string>; created: number }; active: number; stopped: boolean } = {
    active: 0,
    stopped: false,
  }

  function accessToken() {
    const now = Math.floor(Date.now() / 1000)
    if (!state.token || now - state.token.created >= 50 * 60 || now < state.token.created) {
      const value = (async () => {
        const assertion = await new SignJWT({ scope: SCOPE })
          .setProtectedHeader({ alg: "RS256", typ: "JWT" })
          .setIssuer(options.clientEmail)
          .setAudience(tokenURL)
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(key)
        const response = await fetch(tokenURL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
          signal: AbortSignal.timeout(5000),
        })
        if (response.status !== 200) throw new Error(`FCM token request failed: ${response.status}`)
        const value: unknown = await response.json()
        if (typeof value !== "object" || value === null || !("access_token" in value)) throw new Error("FCM token response")
        if (typeof value.access_token !== "string" || value.access_token.length > 4096) throw new Error("FCM token response")
        return value.access_token
      })()
      state.token = { value, created: now }
      void value.catch(() => {
        if (state.token?.value === value) state.token = undefined
      })
    }
    return state.token.value
  }

  return {
    async send(signal: Signal, authorized: () => boolean = () => true): Promise<Result> {
      if (!/^[A-Za-z0-9_:-]{32,4096}$/.test(signal.token)) throw new Error("Invalid FCM registration token")
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(signal.signalID)) throw new Error("Invalid push signal identifier")
      if (signal.kind !== "attention" && signal.kind !== "completed") throw new Error("Invalid push signal kind")
      const id = crypto.randomUUID()
      if (state.stopped) return { status: "rejected", id }
      if (state.active >= 32) return { status: "retryable", id }
      state.active += 1
      try {
        const bearer = await accessToken()
        if (state.stopped || !authorized()) return { status: "rejected", id }
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: signal.token,
              notification: {
                title: "miao",
                body: signal.kind === "attention" ? "A session needs your attention." : "A session has finished.",
              },
              data: { signalID: signal.signalID, kind: signal.kind },
            },
          }),
          signal: AbortSignal.timeout(5000),
        })
        const body = await response.text()
        if (response.status === 200) return { status: "accepted", id }
        if (response.status === 404 || unregistered(body)) return { status: "rejected", id }
        return {
          status: [429, 500, 503].includes(response.status) ? "retryable" : "rejected",
          id,
        }
      } catch {
        // A broken connection may have accepted the request. Never replay a hint.
        return { status: "unknown", id }
      } finally {
        state.active -= 1
      }
    },
    stop() {
      state.stopped = true
      state.token = undefined
    },
  }
}

/** An unregistered FCM token surfaces as a 404 or an UNREGISTERED error detail. */
function unregistered(body: string) {
  if (body.length > 4096) return false
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value !== "object" || value === null) return false
    const error = "error" in value ? value.error : undefined
    if (typeof error !== "object" || error === null) return false
    const details = "details" in error ? error.details : undefined
    if (!Array.isArray(details)) return false
    return details.some(
      (entry) =>
        typeof entry === "object" && entry !== null && "errorCode" in entry && entry.errorCode === "UNREGISTERED",
    )
  } catch {
    return false
  }
}

function requireLoopback(value: string) {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
    throw new Error("FCM fixture must use loopback HTTP")
}

function fixtureEndpoint(value: string) {
  const url = new URL(value)
  requireLoopback(value)
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("FCM fixture must use a bare loopback origin")
  return url.origin
}
