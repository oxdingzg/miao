import { OpenCode } from "@miao/client"
import { RemoteAccess } from "@miao/schema/remote-access"
import { Option, Schema } from "effect"
import { RuntimeConnect } from "@/runtime/connect"

const ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const common = {
  version: Schema.Literal(1),
  storage: Schema.String.check(Schema.isLengthBetween(1, 4096)).pipe(Schema.optional),
}
const bound = { ...common, runtimeID: ID }
const Request = Schema.Union([
  Schema.Struct({ ...common, method: Schema.Literal("status"), runtimeID: ID.pipe(Schema.optional) }),
  Schema.Struct({
    ...bound,
    method: Schema.Literal("session"),
    sessionID: Schema.String.check(Schema.isLengthBetween(1, 128)),
  }),
  Schema.Struct({ ...bound, method: Schema.Literal("invite"), policy: RemoteAccess.Policy }),
  Schema.Struct({ ...bound, method: Schema.Literal("pending") }),
  Schema.Struct({ ...bound, method: Schema.Literal("devices") }),
  Schema.Struct({
    ...bound,
    method: Schema.Literal("approve"),
    pairingID: ID,
    publicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{87}$/)),
  }),
  Schema.Struct({ ...bound, method: Schema.Literal("reject"), pairingID: ID }),
  Schema.Struct({
    ...bound,
    method: Schema.Literal("revoke"),
    grantID: ID,
    grantVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    ...bound,
    method: Schema.Literal("setup"),
    hubURL: Schema.String.check(Schema.isLengthBetween(1, 2048)),
    email: Schema.String.check(Schema.isLengthBetween(1, 320)),
    password: Schema.String.check(Schema.isLengthBetween(1, 4096)),
    name: Schema.String.check(Schema.isLengthBetween(1, 128)),
  }),
])

/** One versioned request on stdin, one response on stdout. Never starts a Runtime. */
export async function run(storage: string) {
  const text = await readInput().catch(() => undefined)
  const json = text === undefined ? Option.none() : Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  const request = Option.isNone(json)
    ? Option.none()
    : Schema.decodeUnknownOption(Request, { onExcessProperty: "error" })(json.value)
  if (Option.isNone(request)) return { version: 1, ok: false, error: "invalidRequest" }
  const input = request.value
  const record = await RuntimeConnect.current(input.storage ?? storage).catch(() => undefined)
  if (!record) return { version: 1, ok: false, error: "noRuntime" }
  if (input.runtimeID !== undefined && input.runtimeID !== record.runtimeID)
    return { version: 1, ok: false, runtimeID: record.runtimeID, error: "runtimeChanged" }
  const client = OpenCode.make({
    baseUrl: record.url,
    headers: { authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}` },
    fetch: Object.assign(
      (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
      { preconnect: fetch.preconnect },
    ),
  })
  const api = client["server.runtime"]
  const read = ["status", "session", "pending", "devices"].includes(input.method)
  const result = await (async () => {
    if (input.method === "status") return api.get()
    if (input.method === "session") {
      const session = await client.sessions.get({ sessionID: input.sessionID })
      return { sessionID: session.id, projectID: session.projectID, title: session.title }
    }
    if (input.method === "invite") return api.invite(input.policy)
    if (input.method === "pending") return api.pending()
    if (input.method === "devices") return api.devices()
    if (input.method === "approve") return api.approve({ pairingID: input.pairingID, publicKey: input.publicKey })
    if (input.method === "reject") {
      await api.reject({ pairingID: input.pairingID })
      return null
    }
    if (input.method === "revoke") return api.revoke({ grantID: input.grantID, version: input.grantVersion })
    const { HubSetup } = await import("@miao/remote-control/hub-setup")
    return HubSetup.connect({
      hubURL: input.hubURL,
      email: input.email,
      password: input.password,
      name: input.name,
      runtime: { get: () => api.get(), configure: (configuration) => api.configure(configuration) },
    })
  })().then(
    (data) => ({ version: 1, ok: true, runtimeID: record.runtimeID, data }),
    () => ({ version: 1, ok: false, runtimeID: record.runtimeID, error: read ? "unavailable" : "unconfirmed" }),
  )
  // SDK and provider exceptions can contain credentials or input values. Only fixed error codes leave this boundary.
  return result
}

async function readInput() {
  const reader = Bun.stdin.stream().getReader()
  const state = { expired: false }
  const timeout = setTimeout(() => {
    state.expired = true
    void reader.cancel().catch(() => undefined)
  }, 5000)
  try {
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let length = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 65_536) {
        await reader.cancel()
        return undefined
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    if (state.expired) return undefined
    chunks.push(decoder.decode())
    return chunks.join("")
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
}

export * as RuntimeAccessCLI from "./runtime-access"
