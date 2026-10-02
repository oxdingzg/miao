import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { NodeFileSystem } from "@effect/platform-node"
import { LLM } from "@miao/llm"
import * as OpenAIChat from "@miao/llm/protocols/openai-chat"
import { Auth, LLMClient, ProviderWireArchive } from "@miao/llm/route"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNodePlatform } from "@miao/core/effect/app-node-platform"
import { Global } from "@miao/core/global"
import { ProviderWireArchiveStore } from "@miao/core/provider-wire-archive"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"
import { exchange, sse } from "./lib/llm-wire"
import { tmpdir } from "./fixture/tmpdir"

const MANAGED_DIRECTORY = ProviderWireArchiveStore.MANAGED_DIRECTORY

const frame = (exchange: string, text: string): ProviderWireArchive.Line => ({
  kind: "frame",
  exchange,
  route: "openai-chat",
  at: 1,
  text,
})

type Destination = string | undefined | ((input: { log: string }) => string)

/**
 * The archive as its consumers see it: resolved from the built layer, so a test
 * asserting absence is asserting what the client and executor would find.
 */
interface Harness {
  readonly log: string
  readonly fs: FileSystem.FileSystem
  /** The armed layer itself, for tests that drive a real request through it. */
  readonly store: Layer.Layer<never, never, never>
  readonly archive: ProviderWireArchive.Interface | undefined
}

const withStore = <A, E>(
  destination: Destination,
  body: (input: Harness) => Effect.Effect<A, E>,
  before?: (input: { log: string; fs: FileSystem.FileSystem }) => Effect.Effect<void, PlatformError>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const previous = process.env["MIAO_LLM_WIRE_ARCHIVE"]
        const value = typeof destination === "function" ? destination({ log: tmp.path }) : destination
        if (value === undefined) delete process.env["MIAO_LLM_WIRE_ARCHIVE"]
        else process.env["MIAO_LLM_WIRE_ARCHIVE"] = value
        const restore = Effect.sync(() => {
          if (previous === undefined) delete process.env["MIAO_LLM_WIRE_ARCHIVE"]
          else process.env["MIAO_LLM_WIRE_ARCHIVE"] = previous
        })
        const fs = yield* FileSystem.FileSystem
        if (before !== undefined) yield* before({ log: tmp.path, fs })
        const store = ProviderWireArchiveStore.layer.pipe(
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Global.layerWith({ log: tmp.path }))),
        )
        const input = yield* Effect.gen(function* () {
          return {
            log: tmp.path,
            fs: yield* FileSystem.FileSystem,
            store,
            archive: Option.getOrUndefined(yield* Effect.serviceOption(ProviderWireArchive.Service)),
          }
        }).pipe(Effect.provide(Layer.mergeAll(store, NodeFileSystem.layer)))
        return yield* body(input).pipe(Effect.ensuring(restore))
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ProviderWireArchiveStore", () => {
  it.live("is absent unless the flag names a destination", () =>
    withStore(undefined, (input) =>
      Effect.gen(function* () {
        expect(input.archive).toBeUndefined()
      }),
    ),
  )

  it.live("appends one NDJSON line per record, in order", () =>
    withStore("1", ({ log, fs, archive }) =>
      Effect.gen(function* () {
        if (archive === undefined) throw new Error("expected an archive")
        yield* archive.record(frame("ex_1", '{"a":1}'))
        yield* archive.record(frame("ex_1", "[DONE]"))

        const directory = path.join(log, MANAGED_DIRECTORY)
        const files = yield* fs.readDirectory(directory)
        expect(files).toHaveLength(1)

        const text = yield* fs.readFileString(path.join(directory, files[0]))
        expect(text.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
          frame("ex_1", '{"a":1}'),
          frame("ex_1", "[DONE]"),
        ])
      }),
    ),
  )

  it.live("uses the flag value itself as the directory when it is a path", () =>
    withStore(
      ({ log }) => path.join(log, "explicit-destination"),
      ({ log, fs, archive }) =>
        Effect.gen(function* () {
          if (archive === undefined) throw new Error("expected an archive")
          yield* archive.record(frame("ex_1", "{}"))
          expect(yield* fs.readDirectory(path.join(log, "explicit-destination"))).toHaveLength(1)
        }),
    ),
  )

  it.live("never fails the caller when the destination cannot be written", () =>
    withStore(path.join("/dev/null", "unwritable"), ({ archive }) =>
      Effect.gen(function* () {
        if (archive === undefined) throw new Error("expected an archive")
        // A diagnostic sink drops its own failures rather than failing the
        // request it is observing, so recording still resolves.
        expect(yield* archive.record(frame("ex_1", "{}"))).toBeUndefined()
      }),
    ),
  )

  it.live("prunes records past retention and keeps the rest", () =>
    withStore(
      "1",
      ({ log, fs }) =>
        Effect.gen(function* () {
          expect(yield* fs.readDirectory(path.join(log, MANAGED_DIRECTORY))).toEqual(["wire_fresh.ndjson"])
        }),
      ({ log, fs }) =>
        Effect.gen(function* () {
          const directory = path.join(log, MANAGED_DIRECTORY)
          yield* fs.makeDirectory(directory, { recursive: true })
          const stale = path.join(directory, "wire_stale.ndjson")
          yield* fs.writeFileString(path.join(directory, "wire_fresh.ndjson"), "{}\n")
          yield* fs.writeFileString(stale, "{}\n")
          const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
          yield* fs.utimes(stale, aged, aged)
        }),
    ),
  )
})

describe("ProviderWireArchiveStore.directoryFor", () => {
  it.live("sends boolean flags to the log directory and paths to themselves", () =>
    Effect.gen(function* () {
      expect(ProviderWireArchiveStore.directoryFor("1", "/log")).toBe(path.join("/log", MANAGED_DIRECTORY))
      expect(ProviderWireArchiveStore.directoryFor("TRUE", "/log")).toBe(path.join("/log", MANAGED_DIRECTORY))
      expect(ProviderWireArchiveStore.directoryFor("/tmp/wire", "/log")).toBe("/tmp/wire")
    }),
  )
})

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("sk-test") })
  .model({ id: "gpt-4o-mini" })

const chatStream = sse([
  { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
  { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
])

/** Only the fields this test asserts on; each archive line carries more. */
const RecordedLine = Schema.Struct({
  kind: Schema.String,
  exchange: Schema.String,
  route: Schema.String,
  url: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(RecordedLine))

const readLines = (fs: FileSystem.FileSystem, directory: string) =>
  Effect.gen(function* () {
    const files = yield* fs.readDirectory(directory)
    expect(files).toHaveLength(1)
    const text = yield* fs.readFileString(path.join(directory, files[0]))
    return text.trimEnd().split("\n").map((line) => decodeLine(line))
  })

describe("ProviderWireArchiveStore end to end", () => {
  it.live("writes the request, the response, and the frames of one real exchange", () =>
    withStore("1", ({ log, fs, store }) =>
      Effect.gen(function* () {
        // The host writer and the LLM-side tap only meet inside a real layer
        // graph, so this drives a request through the route pipeline against a
        // fake provider and reads back what landed on disk.
        const { response } = yield* exchange(
          LLM.request({ model, prompt: "Archive me." }),
          chatStream,
          undefined,
          store,
        )
        expect(response.text).toBe("Hi")

        const lines = yield* readLines(fs, path.join(log, MANAGED_DIRECTORY))

        expect(new Set(lines.map((line) => line.exchange)).size).toBe(1)
        expect(lines.every((line) => line.route === "openai-chat")).toBe(true)

        const requests = lines.filter((line) => line.kind === "request")
        const responses = lines.filter((line) => line.kind === "response")
        const frames = lines.filter((line) => line.kind === "frame")
        expect(requests).toHaveLength(1)
        expect(responses).toHaveLength(1)
        expect(frames.length).toBeGreaterThanOrEqual(2)

        expect(requests[0].url).toBe("https://api.openai.test/v1/chat/completions")
        // Redaction survives the trip through the host writer.
        expect(requests[0].headers?.["authorization"]).toBe("<redacted>")
        expect(responses[0].status).toBe(200)
        expect(frames.map((frame) => frame.text)).toContain(
          JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] }),
        )
      }),
    ),
  )
})

// The archive reaches the client and the executor as separate nodes, so only the
// built application graph can show that a real request records anything at all.
const fakeHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((outgoing) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
      yield* Effect.promise(() => web.text())
      return HttpClientResponse.fromWeb(
        outgoing,
        new Response(chatStream, { headers: { "content-type": "text/event-stream" } }),
      )
    }),
  ),
)

const platformGraph = (log: string) =>
  AppNodeBuilder.build(LayerNodePlatform.llmClient, [
    [Global.node, Global.layerWith({ log })],
    [LayerNodePlatform.httpClient, fakeHttp],
  ])

describe("ProviderWireArchiveStore in the platform graph", () => {
  it.live("leaves the archive absent when the host did not arm it", () =>
    withStore(undefined, ({ log }) =>
      Effect.gen(function* () {
        const present = yield* Effect.gen(function* () {
          yield* LLMClient.Service
          return Option.isSome(yield* Effect.serviceOption(ProviderWireArchive.Service))
        }).pipe(Effect.provide(platformGraph(log)))

        // Absent rather than inert: the llm package decides whether to trace by
        // asking for this service, so a built graph must not offer an empty one.
        expect(present).toBe(false)
      }),
    ),
  )

  it.live("records a request the graph itself performs", () =>
    withStore("1", ({ log, fs }) =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Archive me." })).pipe(
          Effect.provide(platformGraph(log)),
        )
        expect(response.text).toBe("Hi")

        const lines = yield* readLines(fs, path.join(log, MANAGED_DIRECTORY))
        expect(lines.filter((line) => line.kind === "request")).toHaveLength(1)
        expect(lines.filter((line) => line.kind === "response")).toHaveLength(1)
        expect(lines.filter((line) => line.kind === "frame").length).toBeGreaterThanOrEqual(2)
      }),
    ),
  )
})
