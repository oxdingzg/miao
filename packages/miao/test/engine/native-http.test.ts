import { expect, test } from "bun:test"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { SessionEvent } from "@miao/schema/session-event"
import { SessionID } from "@miao/schema/session-id"
import { AbsolutePath } from "@miao/schema/schema"
import { nativeSessionEvents } from "@miao/server/native-events"
import { EngineClient } from "@/engine/client"
import { replayJournal } from "@/engine/journal"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const binary = process.env.MIAO_ENGINE_BIN
const sessionID = Schema.decodeUnknownSync(SessionID)("ses_http_acceptance")
const after = Schema.NumberFromString.pipe(Schema.optional)
const api = HttpApi.make("native-http-probe").add(
  HttpApiGroup.make("session")
    .add(
      HttpApiEndpoint.get("events", "/event", {
        query: { after },
        success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
      }),
    )
    .add(
      HttpApiEndpoint.get("history", "/history", {
        query: { after, limit: Schema.NumberFromString.pipe(Schema.optional) },
        success: Schema.Struct({ data: Schema.Array(SessionEvent.Durable), hasMore: Schema.Boolean }),
      }),
    ),
)

const fixture = Effect.gen(function* () {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  // The model fixture is independent of the Effect HTTP server under test.
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"HTTP OK"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => upstream.stop(true)))
  const client = EngineClient.start({
    binary: binary!,
    db: path.join(tmp.path, "native.db"),
    workspace: tmp.path,
    model: "http-fixture",
    provider: "openai-chat",
    endpoint: upstream.url.toString(),
    env: { OPENAI_API_KEY: "fixture-only" },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => client.close()))
  const finished = new Promise<void>((resolve) =>
    client.onEvent((event) => {
      if (event.session_id === sessionID && event.kind === "run.finished") resolve()
    }),
  )
  yield* Effect.tryPromise(() => client.subscribe(sessionID, 0))
  yield* Effect.tryPromise(() =>
    client.admit(
      {
        session_id: sessionID,
        input_id: "in_http",
        prompt: "hello",
        delivery: "steer",
      },
      true,
    ),
  )
  yield* Effect.promise(() => finished).pipe(Effect.timeout("10 seconds"))
  const location = { directory: AbsolutePath.make(tmp.path) }
  return {
    location,
    storage: AbsolutePath.make(path.join(tmp.path, "native.db")),
    page: (after: number, limit?: number) =>
      Effect.tryPromise(() =>
        replayJournal({
          sessionID,
          after,
          limit,
          location,
          engineID: path.join(tmp.path, "native.db"),
          request: (method, params) => client.request(method, params),
        }),
      ),
  }
})
class Fixture extends Context.Service<Fixture, Effect.Success<typeof fixture>>()("NativeHttpFixture") {}
const handlers = HttpApiBuilder.group(api, "session", (group) =>
  Effect.gen(function* () {
    const value = yield* Fixture
    const decode = Schema.decodeUnknownOption(Schema.toType(SessionEvent.Durable))
    return group
      .handle("events", ({ query }) =>
        Effect.succeed(
          nativeSessionEvents(
            {
              events: (input) => value.page(input.after).pipe(Effect.orDie),
            },
            { sessionID, location: value.location, storage: value.storage, after: query.after ?? 0 },
          ).pipe(Stream.orDie),
        ),
      )
      .handle("history", ({ query }) =>
        value.page(query.after ?? 0, query.limit ?? 1).pipe(
          Effect.map((page) => ({
            data: page.events
              .map((event) => decode(event))
              .filter(Option.isSome)
              .map((event) => event.value),
            hasMore: page.hasMore,
          })),
          Effect.orDie,
        ),
      )
  }),
)
const layer = HttpRouter.serve(
  HttpApiBuilder.layer(api).pipe(Layer.provide(handlers), Layer.provide(Layer.effect(Fixture, fixture))),
  { disableListenLog: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(NodeServices.layer))

if (!binary) test.skip("real native journal survives HTTP history and SSE encoding", () => {})
if (binary)
  testEffect(layer).live(
    "real native journal survives HTTP history and SSE encoding",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClientRequest.get("/history").pipe(HttpClient.execute)
        expect(response.status).toBe(200)
        const page = yield* response.json
        const decoded = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Array(SessionEvent.Durable),
            hasMore: Schema.Boolean,
          }),
        )(page)
        expect(decoded.data.length).toBeGreaterThan(0)
        const first = decoded.data[0]
        expect(first.id).toStartWith("evt_engine_")
        const provenance = first.metadata?.engine
        expect(provenance).toMatchObject({ session_id: sessionID })
        const cursor =
          typeof provenance === "object" && provenance !== null && "seq" in provenance ? provenance.seq : undefined
        expect(typeof cursor).toBe("number")
        const next = yield* HttpClientRequest.get(`/history?after=${cursor}`).pipe(HttpClient.execute)
        expect(next.status).toBe(200)
        const nextPage = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Array(SessionEvent.Durable),
            hasMore: Schema.Boolean,
          }),
        )(yield* next.json)
        expect(nextPage.data.every((event) => event.id !== first.id)).toBe(true)
        const full = yield* HttpClientRequest.get("/history?limit=100").pipe(HttpClient.execute)
        const complete = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Array(SessionEvent.Durable),
            hasMore: Schema.Boolean,
          }),
        )(yield* full.json)
        expect(complete.hasMore).toBe(false)
        expect(
          complete.data.some((event) => event.type === "session.next.text.ended" && event.data.text === "HTTP OK"),
        ).toBe(true)
        const sse = yield* HttpClientRequest.get("/event").pipe(HttpClient.execute)
        expect(sse.status).toBe(200)
        expect(sse.headers["content-type"]).toContain("text/event-stream")
        const chunks = yield* sse.stream.pipe(Stream.decodeText, Stream.take(1), Stream.runCollect)
        expect(chunks.join("")).toContain('"id":"evt_engine_')
        expect(chunks.join("")).toContain('"session_id":"ses_http_acceptance"')
        const resumed = yield* HttpClientRequest.get(`/event?after=${cursor}`).pipe(HttpClient.execute)
        const resumedChunks = yield* resumed.stream.pipe(Stream.decodeText, Stream.take(1), Stream.runCollect)
        expect(resumedChunks.join("")).not.toContain(`"id":"${first.id}"`)
        const replayed = yield* HttpClientRequest.get("/event").pipe(HttpClient.execute)
        const replayedChunks = yield* replayed.stream.pipe(Stream.decodeText, Stream.take(1), Stream.runCollect)
        expect(replayedChunks.join("")).toContain(`"id":"${first.id}"`)
      }),
    20_000,
  )
