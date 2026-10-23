import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Database } from "@miao/core/database/database"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { EventTable } from "@miao/core/event/sql"
import { ClientEvents } from "@miao/server/client-events"
import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"
import { DateTime } from "effect"
import { Location } from "@miao/schema/location"
import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { connectEngine } from "@/engine/connection"
import { EventForwarder } from "@/server/event-forwarder"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(
  AppNodeBuilder.build(LayerNode.group([ClientEvents.node, EventForwarder.node, Database.node])),
)
const binary = process.env.MIAO_ENGINE_BIN

if (!binary) test.skip("native connection delivers committed events to real HTTP SSE and TUI", () => {})
if (binary)
  it.live(
    "native connection delivers committed events to real HTTP SSE and TUI",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const directory = tmp.path
        const upstream = Bun.serve({
          port: 0,
          fetch() {
            return new Response(
              [
                'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"NATIVE_CLIENT_ACK"},"finish_reason":null}]}\n\n',
                'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
                "data: [DONE]\n\n",
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => upstream.stop(true)))
        const local: GlobalEvent[] = []
        const collect = (event: GlobalEvent) => {
          local.push(event)
        }
        GlobalBus.on("event", collect)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            GlobalBus.off("event", collect)
          }),
        )
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(new Request("http://localhost/api/event"), HttpApiApp.context),
        )
        expect(response.status).toBe(200)
        if (!response.body) throw new Error("missing event stream")
        const reader = response.body.getReader()
        yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
        const connected = yield* Effect.promise(() => reader.read())
        expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
        const clients = yield* ClientEvents.Service
        const projected: OpenCodeEvent[] = []
        const unsubscribe = yield* clients.listen((event) =>
          Effect.sync(() => {
            projected.push(event)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const options = {
          binary,
          db: path.join(directory, "engine.db"),
          workspace: directory,
          model: "fixture",
          provider: "openai-chat",
          endpoint: upstream.url.toString(),
          env: { OPENAI_API_KEY: "fixture-only" },
          engineID: "store-native-client",
          location: Schema.decodeUnknownSync(Location.Ref)({ directory }),
        }
        const owner = yield* connectEngine(options)
        const finished = Promise.withResolvers<void>()
        owner.client.onEvent((event) => {
          if (event.kind === "run.finished") finished.resolve()
        })
        const input = {
          sessionID: SessionID.descending("ses_native_client"),
          id: SessionMessage.ID.make("msg_client_fixture"),
          prompt: { text: "queued actual input" },
          delivery: "queue" as const,
        }
        const receipt = yield* Effect.promise(() => owner.session.promptProduct(input))
        expect(receipt).toMatchObject({
          id: input.id,
          sessionID: input.sessionID,
          delivery: "queue",
          prompt: input.prompt,
        })
        expect(DateTime.toEpochMillis(receipt.timeCreated)).toBeGreaterThan(0)
        yield* Effect.promise(() => finished.promise).pipe(Effect.timeout("10 seconds"))
        yield* owner.flush
        const wire = yield* Effect.promise(async () => {
          const decoder = new TextDecoder()
          let body = ""
          while (!body.includes("session.next.assistant.identity")) {
            const chunk = await reader.read()
            if (chunk.done) throw new Error("client event stream closed")
            body += decoder.decode(chunk.value, { stream: true })
          }
          return body
        }).pipe(Effect.timeout("5 seconds"))
        expect(wire).toContain('"delivery":"queue"')
        expect(wire).toContain('"messageID":"msg_client_fixture"')
        const duplicate = yield* Effect.promise(() => owner.session.promptProduct({ ...input, resume: false }))
        expect(duplicate).toEqual(receipt)
        expect(wire).toContain('"id":"store-native-client"')
        expect(wire).not.toContain('"durable":')
        expect(wire).toContain('"provider":{"protocol":"openai-chat","model":"fixture"}')
        expect(wire).toContain('"model":{"id":"fixture","providerID":"openai-chat"}')
        expect(local).toContainEqual(
          expect.objectContaining({
            payload: expect.objectContaining({
              type: "session.next.assistant.identity",
              properties: expect.objectContaining({
                provider: { protocol: "openai-chat", model: "fixture" },
                model: { providerID: "openai-chat", id: "fixture" },
                agent: null,
              }),
            }),
          }),
        )

        expect(local).toContainEqual(
          expect.objectContaining({
            directory,
            payload: expect.objectContaining({
              type: "session.next.text.ended",
              properties: expect.objectContaining({ text: "NATIVE_CLIENT_ACK" }),
            }),
          }),
        )
        expect(local.some((event) => event.payload.type === "sync")).toBe(false)
        const database = yield* Database.Service
        const stored = yield* database.db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, "ses_native_client"))
          .all()
        expect(stored).toHaveLength(0)
        const streamed = projected.filter((event) => event.type === "session.next.text.delta")
        expect(streamed.length).toBeGreaterThan(0)
        expect(streamed.every((event) => event.durable === undefined)).toBe(true)
        const original = projected.filter((event) => event.type !== "session.next.text.delta").map((event) => event.id)
        expect(original.length).toBeGreaterThan(0)
        expect(new Set(original).size).toBe(original.length)
        yield* Effect.promise(() => owner.client.close())
        yield* owner.flush
        projected.length = 0
        const retry = yield* connectEngine(options)
        const replayed = Promise.withResolvers<void>()
        retry.client.onEvent((event) => {
          if (event.kind === "run.finished") replayed.resolve()
        })
        yield* Effect.promise(() => retry.session.promptProduct({ ...input, resume: false }))
        yield* Effect.promise(() => replayed.promise).pipe(Effect.timeout("10 seconds"))
        yield* retry.flush
        expect(projected.map((event) => event.id)).toEqual(original)
        expect(projected.every((event) => event.durable === undefined)).toBe(true)
      }),
    { timeout: 30000 },
  )
