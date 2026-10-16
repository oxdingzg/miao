import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

const Record = Schema.Union([
  Schema.Struct({ type: Schema.Literal("budget"), limit: Schema.Number, targetHash: Schema.String }),
  Schema.Struct({ type: Schema.Literal("attempt"), ordinal: Schema.Number, atMs: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("response"),
    ordinal: Schema.Number,
    status: Schema.Number,
    headersMs: Schema.Number,
    errorCode: Schema.optional(Schema.String),
  }),
])

/** A research-only forwarding boundary. Every provider retry must pass this
 * endpoint; reserve and persist a slot before issuing any upstream request.
 * A restart retains spent attempts, even when no response was received. */
export function startBudgetProxy(input: { upstream: string; limit: number; ledger: string; proxy?: string }) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error("invalid provider request limit")
  const target = new URL(input.upstream)
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("invalid provider endpoint")
  const targetHash = new Bun.CryptoHasher("sha256").update(target.toString()).digest("hex")
  mkdirSync(path.dirname(input.ledger), { recursive: true, mode: 0o700 })
  const lockPath = input.ledger + ".lock"
  const lock = openSync(lockPath, "wx", 0o600)
  const release = () => {
    closeSync(lock)
    unlinkSync(lockPath)
  }
  const write = (record: Schema.Schema.Type<typeof Record>) =>
    appendFileSync(input.ledger, JSON.stringify(record) + "\n", { mode: 0o600 })
  try {
    const records = existsSync(input.ledger)
      ? readFileSync(input.ledger, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => Schema.decodeUnknownSync(Record)(JSON.parse(line)))
      : []
    const budget = records[0]
    if (
      records.length &&
      (budget?.type !== "budget" || budget.limit !== input.limit || budget.targetHash !== targetHash)
    ) {
      throw new Error("provider budget ledger does not match this run")
    }
    if (records.filter((record) => record.type === "budget").length > 1) throw new Error("duplicate provider budget")
    const attempts = records.filter((record) => record.type === "attempt")
    if (attempts.length > input.limit || attempts.some((record, index) => record.ordinal !== index + 1)) {
      throw new Error("invalid provider budget accounting")
    }
    if (!records.length) write({ type: "budget", limit: input.limit, targetHash })
    const state = { used: attempts.length, rejected: 0, closed: false }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        if (request.method !== "POST") return new Response("provider proxy accepts POST only", { status: 405 })
        if (state.used >= input.limit) {
          state.rejected += 1
          return new Response("evaluation provider request budget exhausted", { status: 429 })
        }
        const ordinal = state.used + 1
        const started = Date.now()
        // No await between the limit check and reservation, including journal
        // append. A failed write must never allow a request to escape uncounted.
        write({ type: "attempt", ordinal, atMs: started })
        state.used = ordinal
        const headers = new Headers(request.headers)
        headers.delete("host")
        headers.delete("connection")
        headers.delete("transfer-encoding")
        try {
          // Forward finite JSON with its original Content-Length, rather than
          // relying on streamed request-body framing through an HTTPS proxy.
          const body = await request.arrayBuffer()
          const response = await fetch(target, {
            method: "POST",
            headers,
            body,
            signal: request.signal,
            redirect: "error",
            ...(input.proxy ? { proxy: input.proxy } : {}),
          })
          write({ type: "response", ordinal, status: response.status, headersMs: Date.now() - started })
          const outgoing = new Headers(response.headers)
          // fetch may have decoded compression, so do not forward its original
          // encoding/length or hop-by-hop headers with the decoded stream.
          for (const name of ["content-encoding", "content-length", "connection", "transfer-encoding"])
            outgoing.delete(name)
          return new Response(response.body, { status: response.status, headers: outgoing })
        } catch (error) {
          const code =
            error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "TransportError"
          write({
            type: "response",
            ordinal,
            status: 0,
            headersMs: Date.now() - started,
            errorCode: /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "TransportError",
          })
          return new Response("evaluation upstream transport failed", { status: 502 })
        }
      },
    })
    return {
      endpoint: server.url.toString(),
      stats: () => ({
        limit: input.limit,
        forwarded: state.used,
        remaining: input.limit - state.used,
        rejected: state.rejected,
      }),
      async [Symbol.asyncDispose]() {
        if (state.closed) return
        state.closed = true
        try {
          await server.stop(true)
        } finally {
          release()
        }
      },
    }
  } catch (error) {
    release()
    throw error
  }
}
