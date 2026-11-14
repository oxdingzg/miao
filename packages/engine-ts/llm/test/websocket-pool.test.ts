import { describe, expect } from "bun:test"
import { Cause, Effect, Fiber, Queue, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError, TransportReason } from "../src/schema"
import { WebSocketPool } from "../src/route"
import { it } from "./lib/effect"

const completed = JSON.stringify({ type: "response.completed", response: { id: "resp" } })
const delta = JSON.stringify({ type: "response.output_text.delta", delta: "hi" })

type Reply = "answer" | "silent" | "break"

// A fake server: every socket answers each sent message as `replies` dictates,
// and the log records which sockets were opened, written to, and closed.
function server(replies: Reply[] = []) {
  const log: string[] = []
  let opened = 0
  const open = (request: WebSocketPool.PooledRequest) =>
    Effect.gen(function* () {
      const id = ++opened
      log.push(`open ${id} ${request.headers.authorization}`)
      const messages = yield* Queue.unbounded<string | Uint8Array, LLMError | Cause.Done<void>>()
      return {
        sendText: (message: string) =>
          Effect.sync(() => {
            log.push(`send ${id} ${message}`)
            const reply = replies.shift() ?? "answer"
            if (reply === "answer") [delta, completed].forEach((frame) => Queue.offerUnsafe(messages, frame))
            if (reply === "break")
              Queue.failCauseUnsafe(
                messages,
                Cause.fail(
                  new LLMError({
                    module: "test",
                    method: "message",
                    reason: new TransportReason({ message: "closed with code 1006" }),
                  }),
                ),
              )
          }),
        messages: Stream.fromQueue(messages),
        close: Effect.sync(() => void log.push(`close ${id}`)),
      }
    })
  return { log, open }
}

const request = (message: string, authorization = "Bearer a") => ({
  key: "ses",
  url: "wss://chatgpt.test/backend-api/codex/responses",
  headers: Headers.fromInput({ authorization }),
  message,
})

const http = Stream.make("http-frame")

const run = (pool: WebSocketPool.Interface, message: string, authorization?: string) =>
  pool.stream(request(message, authorization), http).pipe(Stream.runCollect)

describe("WebSocketPool", () => {
  it.live("reuses one socket for a session's consecutive responses", () =>
    Effect.gen(function* () {
      const fake = server()
      const pool = WebSocketPool.make({ open: fake.open })

      expect(yield* run(pool, "one")).toEqual([delta, completed])
      expect(yield* run(pool, "two")).toEqual([delta, completed])
      expect(fake.log).toEqual(["open 1 Bearer a", "send 1 one", "send 1 two"])
    }),
  )

  it.live("sends a request over HTTP while the session's socket is busy", () =>
    Effect.gen(function* () {
      const fake = server(["silent"])
      const pool = WebSocketPool.make({ open: fake.open })
      // The first response never finishes, so its socket stays claimed.
      const pending = yield* run(pool, "one").pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")

      expect(yield* run(pool, "two")).toEqual(["http-frame"])
      expect(fake.log).toEqual(["open 1 Bearer a", "send 1 one"])
      yield* Fiber.interrupt(pending)
    }),
  )

  it.live("retries over HTTP when the socket breaks before answering, then reconnects", () =>
    Effect.gen(function* () {
      const fake = server(["break"])
      const pool = WebSocketPool.make({ open: fake.open })

      expect(yield* run(pool, "one")).toEqual(["http-frame"])
      expect(yield* run(pool, "two")).toEqual([delta, completed])
      expect(fake.log).toEqual(["open 1 Bearer a", "send 1 one", "close 1", "open 2 Bearer a", "send 2 two"])
    }),
  )

  it.live("stops trying sockets for a while after repeated failures", () =>
    Effect.gen(function* () {
      let attempts = 0
      const pool = WebSocketPool.make({
        open: (input) => {
          attempts++
          return Effect.fail(
            new LLMError({ module: "test", method: "open", reason: new TransportReason({ message: input.url }) }),
          )
        },
      })

      for (const message of ["1", "2", "3", "4", "5"]) expect(yield* run(pool, message)).toEqual(["http-frame"])
      expect(attempts).toBe(3)
    }),
  )

  it.live("opens a new socket when the credentials change", () =>
    Effect.gen(function* () {
      const fake = server()
      const pool = WebSocketPool.make({ open: fake.open })

      yield* run(pool, "one", "Bearer a")
      yield* run(pool, "two", "Bearer b")
      expect(fake.log).toEqual(["open 1 Bearer a", "send 1 one", "close 1", "open 2 Bearer b", "send 2 two"])
    }),
  )

  it.live("drops a socket whose response was abandoned midway", () =>
    Effect.gen(function* () {
      const fake = server()
      const pool = WebSocketPool.make({ open: fake.open })

      expect(yield* pool.stream(request("one"), http).pipe(Stream.take(1), Stream.runCollect)).toEqual([delta])
      yield* run(pool, "two")
      expect(fake.log).toEqual(["open 1 Bearer a", "send 1 one", "close 1", "open 2 Bearer a", "send 2 two"])
    }),
  )
})
