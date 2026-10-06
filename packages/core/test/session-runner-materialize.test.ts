import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { SessionMessage } from "@miao/core/session/message"
import { SessionEvent } from "@miao/core/session/event"
import { EventV2 } from "@miao/core/event"
import { materializeBlobRefs, materializeEvent } from "@miao/core/session/runner/materialize-files"
import { ModelV2 } from "@miao/core/model"
import { ProviderV2 } from "@miao/core/provider"
import { SessionID } from "@miao/schema/session-id"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const encoder = new TextEncoder()
const time = { created: DateTime.makeUnsafe(0) }
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const withBlob = <A, E, R>(body: (blob: Blob.Interface) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([Blob.node, FSUtil.node]), [[Global.node, global]])
      return Effect.gen(function* () {
        return yield* body(yield* Blob.Service)
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const user = (files: Array<{ uri: string; mime: string; name?: string }>) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_materialize"),
    type: "user",
    text: "see the file",
    files,
    time,
  })

const assistant = (content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_materialize_assistant"),
    type: "assistant",
    agent: "build",
    model,
    content,
    time,
  })

const tool = (state: SessionMessage.ToolState) =>
  ({
    type: "tool",
    id: "tool_materialize",
    name: "read",
    state,
    time,
  }) satisfies SessionMessage.AssistantTool

const completed = (
  content: SessionMessage.ToolStateCompleted["content"],
  attachments?: SessionMessage.ToolStateCompleted["attachments"],
) =>
  SessionMessage.ToolStateCompleted.make({
    status: "completed",
    input: {},
    structured: {},
    content,
    ...(attachments === undefined ? {} : { attachments }),
  })

/** The tool result content of the first assistant message, for assertions. */
const toolContent = (message: SessionMessage.Message | undefined) => {
  if (message?.type !== "assistant") return undefined
  const item = message.content[0]
  if (item?.type !== "tool" || item.state.status === "pending") return undefined
  return item.state.content
}

const attachments = (message: SessionMessage.Message | undefined) => {
  if (message?.type !== "assistant") return undefined
  const item = message.content[0]
  if (item?.type !== "tool") return undefined
  return item.state.status === "completed" ? item.state.attachments : undefined
}

const sessionID = SessionID.make("ses_materialize")
const assistantMessageID = SessionMessage.ID.make("msg_materialize_assistant")

const progress = (content: SessionEvent.Tool.Progress["data"]["content"]) =>
  SessionEvent.Tool.Progress.make({
    id: EventV2.ID.create(),
    type: "session.next.tool.progress",
    data: {
      timestamp: DateTime.makeUnsafe(0),
      sessionID,
      assistantMessageID,
      callID: "call_materialize",
      structured: {},
      content,
    },
  })

const success = (content: SessionEvent.Tool.Success["data"]["content"], structured: Record<string, unknown> = {}) =>
  SessionEvent.Tool.Success.make({
    id: EventV2.ID.create(),
    type: "session.next.tool.success",
    data: {
      timestamp: DateTime.makeUnsafe(0),
      sessionID,
      assistantMessageID,
      callID: "call_materialize",
      structured,
      content,
      provider: { executed: true },
    },
  })

const structuredOf = (event: SessionEvent.DurableEvent) =>
  event.type === "session.next.tool.success" || event.type === "session.next.tool.progress"
    ? event.data.structured
    : undefined

const prompted = (files: SessionEvent.Prompted["data"]["prompt"]["files"]) =>
  SessionEvent.Prompted.make({
    id: EventV2.ID.create(),
    type: "session.next.prompted",
    data: {
      timestamp: DateTime.makeUnsafe(0),
      sessionID,
      messageID: SessionMessage.ID.make("msg_materialize"),
      prompt: { text: "see the file", files },
      delivery: "steer",
    },
  })

const eventContent = (event: SessionEvent.DurableEvent) =>
  event.type === "session.next.tool.progress" || event.type === "session.next.tool.success"
    ? event.data.content
    : undefined

describe("materializeBlobRefs", () => {
  it.live("resolves a blob reference into a data URI", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "text/plain" })
        const [result] = yield* materializeBlobRefs(blob, [
          user([{ uri: Blob.refUri(ref.hash), mime: "text/plain", name: "a.txt" }]),
        ])
        expect(result?.type === "user" ? result.files?.[0]?.uri : undefined).toBe("data:text/plain;base64,aGk=")
      }),
    ),
  )

  it.live("replaces a missing blob with a text note", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const [result] = yield* materializeBlobRefs(blob, [
          user([{ uri: Blob.refUri("0".repeat(64)), mime: "text/plain", name: "gone.txt" }]),
        ])
        expect(result?.type === "user" ? result.files : "x").toBeUndefined()
        expect(result?.type === "user" ? result.text : "").toContain("attachment unavailable: gone.txt")
      }),
    ),
  )

  it.live("leaves inline data URIs untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const uri = "data:text/plain;base64,aGk="
        const [result] = yield* materializeBlobRefs(blob, [user([{ uri, mime: "text/plain" }])])
        expect(result?.type === "user" ? result.files?.[0]?.uri : undefined).toBe(uri)
      }),
    ),
  )

  it.live("resolves a blob reference inside a tool result", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "text/plain" })
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([
            tool(completed([{ type: "file", uri: Blob.refUri(ref.hash), mime: "text/plain", name: "a.txt" }])),
          ]),
        ])
        const part = toolContent(result)?.[0]
        expect(part?.type === "file" ? part.uri : undefined).toBe("data:text/plain;base64,aGk=")
      }),
    ),
  )

  it.live("replaces a missing tool-result blob with a text part", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([
            tool(completed([{ type: "file", uri: Blob.refUri("0".repeat(64)), mime: "image/png", name: "shot.png" }])),
          ]),
        ])
        const content = toolContent(result)
        expect(content?.[0]?.type).toBe("text")
        expect(content?.[0]?.type === "text" ? content[0].text : "").toContain("attachment unavailable: shot.png")
      }),
    ),
  )

  it.live("resolves a blob reference in a tool attachment", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "image/png" })
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([
            tool(
              completed(
                [{ type: "text", text: "ok" }],
                [{ uri: Blob.refUri(ref.hash), mime: "image/png", name: "shot.png" }],
              ),
            ),
          ]),
        ])
        expect(attachments(result)?.[0]?.uri).toBe("data:image/png;base64,aGk=")
      }),
    ),
  )

  it.live("moves a missing attachment to a text part instead of dropping it", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([
            tool(
              completed(
                [{ type: "text", text: "ok" }],
                [{ uri: Blob.refUri("0".repeat(64)), mime: "image/png", name: "gone.png" }],
              ),
            ),
          ]),
        ])
        expect(attachments(result)).toBeUndefined()
        const content = toolContent(result)
        expect(content?.[1]?.type === "text" ? content[1].text : "").toContain("attachment unavailable: gone.png")
      }),
    ),
  )

  it.live("leaves non-reference tool content untouched", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const uri = "data:image/png;base64,aGk="
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([tool(completed([{ type: "file", uri, mime: "image/png" }]))]),
        ])
        const part = toolContent(result)?.[0]
        expect(part?.type === "file" ? part.uri : undefined).toBe(uri)
      }),
    ),
  )

  it.live("restores a structured content reference inside a tool result", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "image/png" })
        const [result] = yield* materializeBlobRefs(blob, [
          assistant([
            tool(
              SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: {},
                structured: { encoding: "base64", mime: "image/png", content: Blob.refUri(ref.hash), contentRef: true },
                content: [],
              }),
            ),
          ]),
        ])
        const item = result?.type === "assistant" ? result.content[0] : undefined
        const structured =
          item?.type === "tool" && item.state.status === "completed" ? item.state.structured : undefined
        expect(structured?.content).toBe("aGk=")
        expect(structured !== undefined && "contentRef" in structured).toBe(false)
      }),
    ),
  )
})

describe("materializeEvent", () => {
  it.live("resolves a blob reference in a tool result event", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "image/png" })
        const event = yield* materializeEvent(
          blob,
          new Map(),
          success([{ type: "file", uri: Blob.refUri(ref.hash), mime: "image/png", name: "a.png" }]),
        )
        const part = eventContent(event)?.[0]
        expect(part?.type === "file" ? part.uri : undefined).toBe("data:image/png;base64,aGk=")
      }),
    ),
  )

  it.live("replaces a missing blob in a tool event with a text part", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const event = yield* materializeEvent(
          blob,
          new Map(),
          progress([{ type: "file", uri: Blob.refUri("0".repeat(64)), mime: "image/png", name: "gone.png" }]),
        )
        const content = eventContent(event)
        expect(content?.[0]?.type).toBe("text")
        expect(content?.[0]?.type === "text" ? content[0].text : "").toContain("attachment unavailable: gone.png")
      }),
    ),
  )

  it.live("resolves a blob reference in a prompt event", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "text/plain" })
        const event = yield* materializeEvent(
          blob,
          new Map(),
          prompted([{ uri: Blob.refUri(ref.hash), mime: "text/plain", name: "a.txt" }]),
        )
        expect(event.type === "session.next.prompted" ? event.data.prompt.files?.[0]?.uri : undefined).toBe(
          "data:text/plain;base64,aGk=",
        )
      }),
    ),
  )

  it.live("moves a missing prompt attachment into the prompt text", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const event = yield* materializeEvent(
          blob,
          new Map(),
          prompted([{ uri: Blob.refUri("0".repeat(64)), mime: "text/plain", name: "gone.txt" }]),
        )
        const prompt = event.type === "session.next.prompted" ? event.data.prompt : undefined
        expect(prompt?.files).toBeUndefined()
        expect(prompt?.text).toContain("attachment unavailable: gone.txt")
      }),
    ),
  )

  it.live("returns an event without references unchanged", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const event = SessionEvent.Text.Ended.make({
          id: EventV2.ID.create(),
          type: "session.next.text.ended",
          data: {
            timestamp: DateTime.makeUnsafe(0),
            sessionID,
            assistantMessageID,
            textID: "text_materialize",
            text: "hello",
          },
        })
        expect(yield* materializeEvent(blob, new Map(), event)).toBe(event)
      }),
    ),
  )

  it.live("restores a structured content reference in a tool result event", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "image/png" })
        const event = yield* materializeEvent(
          blob,
          new Map(),
          success([], { encoding: "base64", mime: "image/png", content: Blob.refUri(ref.hash), contentRef: true }),
        )
        const structured = structuredOf(event)
        expect(structured?.content).toBe("aGk=")
        expect(structured !== undefined && "contentRef" in structured).toBe(false)
      }),
    ),
  )

  it.live("reads a repeated blob once through a shared cache", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("hi"), mime: "image/png" })
        let reads = 0
        const counted: Blob.Interface = {
          ...blob,
          getBase64: (hash) => {
            reads++
            return blob.getBase64(hash)
          },
        }
        const cache = new Map<string, string | undefined>()
        const content = [{ type: "file" as const, uri: Blob.refUri(ref.hash), mime: "image/png", name: "a.png" }]
        yield* materializeEvent(counted, cache, progress(content))
        yield* materializeEvent(counted, cache, success(content))
        expect(reads).toBe(1)
      }),
    ),
  )

  it.live("preserves structured output that contains no content references", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const structured = {
          matches: [{ path: "source.ts", line: 7, preview: "contentRef: true" }],
          empty: null,
          flag: { contentRef: true, content: 42 },
        }
        const event = success([], structured)
        const result = yield* materializeEvent(blob, new Map(), event)
        expect(structuredOf(result)).toBe(structuredOf(event))
      }),
    ),
  )

  it.live("finds nested references and preserves missing-blob behavior without mutating history", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const ref = yield* blob.put({ bytes: encoder.encode("nested text"), mime: "text/plain" })
        const structured = {
          results: [
            { contentRef: true, content: Blob.refUri(ref.hash) },
            { nested: { contentRef: true, content: Blob.refUri("0".repeat(64)) } },
          ],
        }
        const result = yield* materializeEvent(blob, new Map(), success([], structured))
        expect(structuredOf(result)).toEqual({ results: [{ content: "nested text" }, { nested: { content: "" } }] })
        expect(structured.results[0]).toEqual({ contentRef: true, content: Blob.refUri(ref.hash) })
      }),
    ),
  )

  it.live("keeps the previous normalization for non-JSON objects", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const array = Object.assign([1, 2], { toJSON: () => "plugin-value" })
        const result = yield* materializeEvent(
          blob,
          new Map(),
          success([], { date: new Date(0), bytes: new Uint8Array([1, 2]), array }),
        )
        expect(structuredOf(result)).toEqual({ date: {}, bytes: { 0: 1, 1: 2 }, array: [1, 2] })
      }),
    ),
  )

  it.live("handles deeply nested reference-free data without recursive scanning", () =>
    withBlob((blob) =>
      Effect.gen(function* () {
        const structured = Array.from({ length: 10_000 }).reduce<Record<string, unknown>>(
          (value) => ({ nested: value }),
          {},
        )
        const event = success([], structured)
        const result = yield* materializeEvent(blob, new Map(), event)
        expect(structuredOf(result)).toBe(structuredOf(event))
      }),
    ),
  )

  if (process.env.MIAO_BENCHMARK_MATERIALIZE === "1")
    it.live(
      "benchmarks structured history materialization",
      () =>
        withBlob((blob) =>
          Effect.gen(function* () {
            const messages = Array.from({ length: 100 }, () =>
              assistant([
                tool({
                  ...completed([]),
                  structured: {
                    matches: Array.from({ length: 100 }, (_, index) => ({
                      path: `source-${index}.ts`,
                      line: index,
                      preview: "matching source",
                      detail: { kind: "text", truncated: false },
                    })),
                  },
                }),
              ]),
            )
            yield* Effect.forEach(Array.from({ length: 5 }), () => materializeBlobRefs(blob, messages), {
              discard: true,
            })
            const samples = yield* Effect.forEach(Array.from({ length: 20 }), () =>
              Effect.gen(function* () {
                const start = performance.now()
                const result = yield* materializeBlobRefs(blob, messages)
                expect(result).toHaveLength(100)
                return performance.now() - start
              }),
            )
            const sorted = samples.toSorted((a, b) => a - b)
            console.log(
              JSON.stringify({
                messages: 100,
                matches: 10_000,
                n: samples.length,
                p50: sorted[9],
                p90: sorted[17],
                p99: sorted[19],
              }),
            )
          }),
        ),
      30_000,
    )
})
