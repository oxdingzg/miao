import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { BlackboxTape } from "@miao/core/blackbox/tape"
import { Schema } from "effect"

const Head = Schema.Struct({
  type: Schema.Literal("head"),
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
})
const Bytes = Schema.Struct({ type: Schema.Literal("bytes"), base64: Schema.String })
const decodeHead = Schema.decodeUnknownSync(Head)
const decodeBytes = Schema.decodeUnknownSync(Bytes)

/** Fixed-upstream, loopback-only boundary shared by TS routes and Rust sidecars.
 * Node HTTP is intentional: destroying a response reproduces a broken transport;
 * a web Response stream error can instead become a clean EOF in the host server. */
export async function providerProxy(
  input: {
    port?: number
    lane?: string
  } & ({ recorder: BlackboxTape.Recorder; upstream: string } | { replay: BlackboxTape.Replay; timing?: boolean }),
) {
  const lane = input.lane ?? "provider"
  const failures: Error[] = []
  const active = new Set<Promise<void>>()
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST") {
      response.writeHead(405).end("Expected a provider POST")
      return
    }
    const abort = new AbortController()
    response.on("close", () => {
      if (!response.writableEnded) abort.abort()
    })
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = BlackboxTape.json(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString()),
    )
    const match = { method: request.method, path: new URL(request.url ?? "/", "http://localhost").pathname, body }
    const write = async (bytes: Uint8Array) => {
      if (!response.write(bytes)) await once(response, "drain", { signal: abort.signal })
    }
    if ("replay" in input) {
      const recorded = (() => {
        try {
          return input.replay.take(lane, match)
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error("Replay failed"))
          return undefined
        }
      })()
      if (!recorded) {
        response.writeHead(409).end("Blackbox request mismatch; no recorded response was delivered")
        return
      }
      if (!recorded.frames[0]) {
        response.destroy()
        return
      }
      const head = decodeHead(recorded.frames[0].value)
      if (input.timing) await Bun.sleep(recorded.frames[0].elapsedMs)
      response.writeHead(head.status, head.headers)
      response.flushHeaders()
      let previous = recorded.frames[0].elapsedMs
      for (const frame of recorded.frames.slice(1)) {
        if (input.timing) await Bun.sleep(Math.max(0, frame.elapsedMs - previous))
        previous = frame.elapsedMs
        await write(Buffer.from(decodeBytes(frame.value).base64, "base64"))
      }
      if (recorded.outcome !== "complete") {
        // Flush partial bytes before breaking the socket; otherwise the replay
        // may look like a failure before output rather than after output.
        await Bun.sleep(input.timing ? Math.max(0, (recorded.endElapsedMs ?? previous) - previous) : 0)
        response.destroy()
        return
      }
      response.end()
      return
    }
    const ticket = await input.recorder.begin(lane, match)
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "content-length", "connection", "accept-encoding"].includes(name)) continue
      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }
    try {
      const upstream = await fetch(input.upstream, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
        redirect: "error",
      })
      const safe = Object.fromEntries(
        ["content-type", "retry-after"].flatMap((key) => {
          const value = upstream.headers.get(key)
          return value === null ? [] : [[key, value]]
        }),
      )
      await ticket.frame({ type: "head", status: upstream.status, headers: safe })
      response.writeHead(upstream.status, safe)
      response.flushHeaders()
      const reader = upstream.body?.getReader()
      if (reader)
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          await ticket.frame({ type: "bytes", base64: Buffer.from(next.value).toString("base64") })
          await write(next.value)
        }
      await ticket.finish("complete")
      response.end()
    } catch {
      await ticket.finish(abort.signal.aborted ? "cancelled" : "error", { message: "Provider transport interrupted" })
      response.destroy()
    }
  }
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      failures.push(error instanceof Error ? error : new Error("Blackbox HTTP boundary failed"))
      response.destroy()
    })
    active.add(operation)
    void operation.finally(() => active.delete(operation))
  })
  server.listen(input.port ?? 0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Blackbox server has no loopback address")
  const url = new URL(`http://127.0.0.1:${address.port}/`)
  return {
    failures,
    url: url.toString(),
    server: {
      url,
      async stop(force = false) {
        if (force) server.closeAllConnections()
        if (server.listening)
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        await Promise.all(active)
      },
    },
  }
}
