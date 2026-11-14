import { expect } from "bun:test"
import { createServer } from "node:net"
import { Cause, Effect, Fiber, Layer, Random, Ref } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { RequestExecutor } from "../src/route"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/responses?api_key=secret")
const midpoint = { nextDoubleUnsafe: () => 0.5, nextIntUnsafe: () => 0 }

function connectionLayer(attempts: Ref.Ref<number>, cause: unknown, failures: number) {
  return RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const attempt = yield* Ref.getAndUpdate(attempts, (value) => value + 1)
            if (attempt < failures)
              return yield* new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              })
            return HttpClientResponse.fromWeb(request, new Response("ok"))
          }),
        ),
      ),
    ),
  )
}

;[
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ConnectionClosed",
  "ConnectionRefused",
  "FailedToOpenSocket",
  "Timeout",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
].forEach((code) => {
  ;[false, true].forEach((wrapped) => {
    it.effect(`retries ${wrapped ? "wrapped" : "direct"} ${code} before receiving a response`, () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0)
        const cause = Object.assign(new Error("socket closed"), { code })
        const fiber = yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor.execute(request)
        }).pipe(
          Effect.provide(connectionLayer(attempts, wrapped ? new TypeError("fetch failed", { cause }) : cause, 1)),
          Effect.forkChild,
        )
        yield* TestClock.adjust(499)
        expect(yield* Ref.get(attempts)).toBe(1)
        yield* TestClock.adjust(1)
        expect((yield* Fiber.join(fiber)).status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(2)
      }).pipe(Effect.provideService(Random.Random, midpoint)),
    )
  })
})
;[
  new Cause.TimeoutError(),
  new DOMException("request timed out", "TimeoutError"),
  new TypeError("fetch failed", {
    cause: new Error("wrapped", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
  }),
  new AggregateError([
    Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  ]),
].forEach((cause, index) => {
  it.effect(`retries structured timeout and nested connection failures (${index})`, () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const fiber = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* executor.execute(request)
      }).pipe(Effect.provide(connectionLayer(attempts, cause, 1)), Effect.forkChild)
      yield* TestClock.adjust(500)
      expect((yield* Fiber.join(fiber)).status).toBe(200)
      expect(yield* Ref.get(attempts)).toBe(2)
    }).pipe(Effect.provideService(Random.Random, midpoint)),
  )
})
;[
  ...[
    "ENOTFOUND",
    "ERR_INVALID_URL",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ABORT_ERR",
  ].map((code) => Object.assign(new Error(code), { code })),
  new DOMException("cancelled", "AbortError"),
  Object.assign(new Error("invalid request", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }), {
    code: "ERR_INVALID_URL",
  }),
  new AggregateError([Object.assign(new Error("reset"), { code: "ECONNRESET" }), new Error("invalid request")]),
  new AggregateError([]),
  Object.assign(new Error("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"), { code: "CERT_HAS_EXPIRED" }),
].forEach((cause, index) => {
  it.effect(`does not retry permanent, cancelled or unknown failures (${index})`, () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const error = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* executor.execute(request)
      }).pipe(Effect.provide(connectionLayer(attempts, cause, Infinity)), Effect.flip)
      expect(error.retryable).toBe(false)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})

it.effect("gives connection resets a deeper budget than provider errors", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const fiber = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request)
    }).pipe(
      Effect.provide(
        connectionLayer(attempts, Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), Infinity),
      ),
      Effect.flip,
      Effect.forkChild,
    )
    yield* TestClock.adjust(500)
    expect(yield* Ref.get(attempts)).toBe(2)
    // Delays 1s + 2s + 4s + 8s exhaust the five-retry connection budget.
    yield* TestClock.adjust(15_000)
    const error = yield* Fiber.join(fiber)
    expect(yield* Ref.get(attempts)).toBe(6)
    expect(error.retryable).toBe(true)
    expect(error.reason).toMatchObject({
      _tag: "Transport",
      kind: "connection-closed",
      message: "socket closed / ECONNRESET",
    })
    expect(JSON.stringify(error.reason)).not.toContain("secret")
  }).pipe(Effect.provideService(Random.Random, midpoint)),
)

it.effect("keeps the short request budget for a non-connection provider error", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const fiber = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request)
    }).pipe(
      Effect.provide(
        RequestExecutor.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.gen(function* () {
                  yield* Ref.update(attempts, (value) => value + 1)
                  return HttpClientResponse.fromWeb(request, new Response("boom", { status: 500 }))
                }),
              ),
            ),
          ),
        ),
      ),
      Effect.flip,
      Effect.forkChild,
    )
    yield* TestClock.adjust(500)
    expect(yield* Ref.get(attempts)).toBe(2)
    yield* TestClock.adjust(1000)
    const error = yield* Fiber.join(fiber)
    expect(yield* Ref.get(attempts)).toBe(3)
    expect(error.reason._tag).toBe("ProviderInternal")
  }).pipe(Effect.provideService(Random.Random, midpoint)),
)

it.effect("interrupting the retry delay prevents another request", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const fiber = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request)
    }).pipe(
      Effect.provide(
        connectionLayer(attempts, Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), Infinity),
      ),
      Effect.forkChild,
    )
    yield* TestClock.adjust(499)
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust(5000)
    expect(yield* Ref.get(attempts)).toBe(1)
  }).pipe(Effect.provideService(Random.Random, midpoint)),
)

it.effect("does not infer retries from error message text", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const error = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request)
    }).pipe(
      Effect.provide(connectionLayer(attempts, new Error("Invalid request containing ECONNRESET"), Infinity)),
      Effect.flip,
    )
    expect(error.retryable).toBe(false)
    expect(yield* Ref.get(attempts)).toBe(1)
  }),
)

it.live("recovers through the real fetch layer when a server closes the first connection", () =>
  Effect.gen(function* () {
    const attempts = { count: 0 }
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
            const server = createServer((socket) => {
              socket.once("data", () => {
                attempts.count++
                if (attempts.count === 1) return socket.destroy()
                socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
              })
            })
            server.once("error", reject)
            server.listen(0, "127.0.0.1", () => resolve(server))
          }),
      ),
      (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing server address")
    const executor = yield* RequestExecutor.Service
    const response = yield* executor.execute(HttpClientRequest.post(`http://127.0.0.1:${address.port}/responses`))
    expect(yield* response.text).toBe("ok")
    expect(attempts.count).toBe(2)
  }).pipe(Effect.provide(RequestExecutor.fetchLayer)),
)
