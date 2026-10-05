export * as PushProvider from "./push-provider"

import { connect, type ClientHttp2Session } from "node:http2"
import { importPKCS8, SignJWT } from "jose"

export type Options = {
  teamID: string
  keyID: string
  privateKey: string
  topic: string
  environment: "sandbox" | "production"
  /** Explicit loopback-only HTTP/2 fixture; production always uses Apple's TLS endpoint. */
  testEndpoint?: string
}
export type Signal = { token: string; signalID: string; kind: "attention" | "completed" }
export type Result =
  | { status: "accepted"; id: string }
  | { status: "unregistered"; id: string; timestamp?: number }
  | { status: "rejected" | "retryable" | "unknown"; id: string }

/** Sends generic wake-up hints. Session contents, credentials and commands never enter the payload. */
export async function create(options: Options) {
  if (!/^[A-Z0-9]{10}$/.test(options.teamID) || !/^[A-Z0-9]{10}$/.test(options.keyID))
    throw new Error("Invalid APNs signing identifiers")
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(options.topic)) throw new Error("Invalid APNs topic")
  if (options.environment !== "sandbox" && options.environment !== "production")
    throw new Error("Invalid APNs environment")
  const endpoint = options.testEndpoint
    ? fixtureEndpoint(options.testEndpoint)
    : options.environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com"
  const key = await importPKCS8(options.privateKey, "ES256")
  const state: {
    session?: ClientHttp2Session
    token?: { value: Promise<string>; created: number }
    active: number
    stopped: boolean
  } = { active: 0, stopped: false }
  const sessions = new Set<ClientHttp2Session>()
  function authorization() {
    const now = Math.floor(Date.now() / 1000)
    if (!state.token || now - state.token.created >= 50 * 60 || now < state.token.created) {
      const value = new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: options.keyID })
        .setIssuer(options.teamID)
        .setIssuedAt(now)
        .sign(key)
      state.token = { value, created: now }
      void value.catch(() => {
        if (state.token?.value === value) state.token = undefined
      })
    }
    return state.token.value
  }
  function connection() {
    if (state.session && !state.session.closed && !state.session.destroyed) return state.session
    const session = connect(endpoint, { minVersion: "TLSv1.2" })
    state.session = session
    sessions.add(session)
    session.on("error", () => {
      if (state.session === session) state.session = undefined
      session.destroy()
    })
    session.on("goaway", () => {
      if (state.session === session) state.session = undefined
      session.close()
    })
    session.on("close", () => {
      sessions.delete(session)
      if (state.session === session) state.session = undefined
    })
    return session
  }
  return {
    async send(signal: Signal): Promise<Result> {
      if (!/^(?:[a-fA-F0-9]{2}){16,256}$/.test(signal.token)) throw new Error("Invalid APNs device token")
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(signal.signalID)) throw new Error("Invalid push signal identifier")
      if (signal.kind !== "attention" && signal.kind !== "completed") throw new Error("Invalid push signal kind")
      const id = crypto.randomUUID()
      if (state.stopped) return { status: "rejected", id }
      if (state.active >= 32) return { status: "retryable", id }
      state.active += 1
      try {
        const bearer = await authorization()
        if (state.stopped) return { status: "rejected", id }
        const body = JSON.stringify({
          aps: {
            alert: {
              title: "miao",
              body: signal.kind === "attention" ? "A session needs your attention." : "A session has finished.",
            },
            sound: "default",
          },
          signalID: signal.signalID,
        })
        return await new Promise<Result>((resolve) => {
          const stream = connection().request({
            ":method": "POST",
            ":path": `/3/device/${signal.token.toLowerCase()}`,
            authorization: `bearer ${bearer}`,
            "apns-topic": options.topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": "0",
            "apns-id": id,
            "content-type": "application/json",
          })
          const response = { status: 0, bytes: 0, chunks: [] as Buffer[], settled: false }
          const finish = (result: Result) => {
            if (response.settled) return
            response.settled = true
            clearTimeout(timer)
            resolve(result)
          }
          const timer = setTimeout(() => {
            finish({ status: "unknown", id })
            stream.close()
          }, 5000)
          stream.on("response", (headers) => {
            response.status = Number(headers[":status"])
          })
          stream.on("data", (chunk: Buffer) => {
            response.bytes += chunk.byteLength
            if (response.bytes > 4096) {
              finish({ status: "unknown", id })
              stream.close()
              return
            }
            response.chunks.push(Buffer.from(chunk))
          })
          stream.on("error", () => finish({ status: "unknown", id }))
          stream.on("close", () => finish({ status: "unknown", id }))
          stream.on("end", () => {
            if (response.status === 200) return finish({ status: "accepted", id })
            if (response.status === 410) {
              const raw: unknown = parse(Buffer.concat(response.chunks).toString("utf8"))
              const timestamp =
                typeof raw === "object" &&
                raw !== null &&
                "timestamp" in raw &&
                typeof raw.timestamp === "number" &&
                Number.isSafeInteger(raw.timestamp) &&
                raw.timestamp >= 0
                  ? raw.timestamp
                  : undefined
              return finish({ status: "unregistered", id, ...(timestamp === undefined ? {} : { timestamp }) })
            }
            finish({
              status: [429, 500, 503].includes(response.status)
                ? "retryable"
                : response.status >= 400
                  ? "rejected"
                  : "unknown",
              id,
            })
          })
          stream.end(body)
        })
      } catch {
        // A broken connection may have accepted the request. Never automatically replay a hint.
        return { status: "unknown", id }
      } finally {
        state.active -= 1
      }
    },
    stop() {
      state.stopped = true
      state.token = undefined
      sessions.forEach((session) => session.destroy())
      sessions.clear()
      state.session = undefined
    },
  }
}

function fixtureEndpoint(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("APNs fixture must use loopback HTTP")
  return url.origin
}
function parse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
