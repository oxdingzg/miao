import { expect } from "bun:test"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError } from "../src/schema"
import { WebSocketPool } from "../src/route"
import { fromWebSocket } from "../src/route/transport/websocket"
import { it } from "./lib/effect"

it.live("a slow consumer retains every burst frame and completion on a pooled socket", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const frames = Array.from({ length: 512 }, (_, index) =>
        JSON.stringify({ type: "response.output_text.delta", delta: String(index) }),
      )
      frames.push(JSON.stringify({ type: "response.completed" }))
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, server) {
          if (server.upgrade(request)) return
          return new Response("Expected WebSocket", { status: 426 })
        },
        websocket: {
          message(socket) {
            frames.forEach((frame) => socket.send(frame))
            // A pooled provider socket stays open after response.completed.
          },
        },
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          void server.stop(true)
        }),
      )
      const pool = WebSocketPool.make({ open: (request) => fromWebSocket(new WebSocket(request.url), request) })
      yield* Effect.addFinalizer(() => pool.close)
      const seen: string[] = []
      const result = yield* pool
        .stream(
          {
            key: "ses_burst",
            url: server.url.toString().replace("http:", "ws:"),
            headers: Headers.empty,
            message: "request",
          },
          Stream.die("must not replay over HTTP"),
        )
        .pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              seen.push(frame)
            }).pipe(Effect.andThen(Effect.sleep("1 millis"))),
          ),
          Stream.runDrain,
          Effect.timeoutOption("2 seconds"),
        )
      expect({ completed: Option.isSome(result), received: seen.length }).toEqual({
        completed: true,
        received: frames.length,
      })
      expect(seen).toEqual(frames)
    }),
  ),
)

function fixture(code: "terminate" | 1008 | 1012) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("Expected WebSocket", { status: 426 })
    },
    websocket: {
      message(socket) {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }))
        setTimeout(() => (code === "terminate" ? socket.terminate() : socket.close(code)), 20)
      },
    },
  })
  return { server, url: server.url.toString().replace("http:", "ws:") }
}

for (const code of ["terminate", 1012, 1008] as const) {
  it.live(`real socket ${code} preserves partial frames, avoids HTTP replay, and classifies recovery`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = fixture(code)
        // Bun 1.3 can retain a terminated upgrade in its stop promise counter.
        // Force-stop closes the listener synchronously; do not wait on that counter.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            void local.server.stop(true)
          }),
        )
        const pool = WebSocketPool.make({ open: (request) => fromWebSocket(new WebSocket(request.url), request) })
        yield* Effect.addFinalizer(() => pool.close)
        const seen: string[] = []
        let http = 0
        const result = yield* pool
          .stream(
            {
              key: "ses_disconnect",
              url: local.url,
              headers: Headers.empty,
              message: "request",
            },
            Stream.make("must-not-replay").pipe(
              Stream.onStart(
                Effect.sync(() => {
                  http++
                }),
              ),
            ),
          )
          .pipe(
            Stream.tap((frame) =>
              Effect.sync(() => {
                seen.push(frame)
              }),
            ),
            Stream.runDrain,
            Effect.exit,
          )
        expect(seen).toEqual([JSON.stringify({ type: "response.output_text.delta", delta: "partial" })])
        expect(http).toBe(0)
        if (!Exit.isFailure(result)) throw new Error("Expected socket failure")
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(LLMError)
        if (!(error instanceof LLMError)) throw new Error("Expected classified transport failure")
        expect(error.reason._tag).toBe("Transport")
        expect(error.retryable).toBe(code !== 1008)
        if (code === "terminate") expect(error.message).toContain("1006")
      }),
    ),
  )
}
