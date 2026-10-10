import { expect } from "bun:test"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventTable } from "@miao/core/event/sql"
import { OpenCodeEvent } from "@miao/protocol/groups/event"
import { ClientEvents } from "@miao/server/client-events"
import { DateTime, Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventForwarder } from "@/server/event-forwarder"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect, testEffectShared } from "../lib/effect"

const message = Schema.decodeUnknownSync(OpenCodeEvent)({
  id: "evt_engine_test",
  type: "session.next.text.ended",
  location: { directory: "/tmp/engine-client" },
  data: {
    timestamp: 123,
    sessionID: "ses_engine_client",
    assistantMessageID: "msg_engine_client",
    textID: "text_engine_client",
    text: "committed by Rust",
  },
})

const it = testEffect(ClientEvents.layer)

it.effect("fans out a durable-shaped product payload without requiring a database", () =>
  Effect.gen(function* () {
    const clients = yield* ClientEvents.Service
    expect(Option.isNone(yield* Effect.serviceOption(Database.Service))).toBe(true)
    const first = yield* clients.allBounded(8)
    const second = yield* clients.allBounded(8)
    yield* clients.publish(message)
    expect(Array.from(yield* first.pipe(Stream.take(1), Stream.runCollect))).toEqual([message])
    expect(Array.from(yield* second.pipe(Stream.take(1), Stream.runCollect))).toEqual([message])
  }),
)

it.effect("fails only the slow subscriber and keeps the publisher and other clients live", () =>
  Effect.gen(function* () {
    const clients = yield* ClientEvents.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const slowStream = yield* clients.allBounded(1)
    const fastStream = yield* clients.allBounded(8)
    const slow = yield* slowStream.pipe(
      Stream.runForEach(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      Effect.forkScoped,
    )
    const fast = yield* fastStream.pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
    yield* clients.publish(message)
    yield* Deferred.await(entered)
    yield* clients.publish(message)
    yield* clients.publish(message)
    yield* clients.publish(message)
    yield* Deferred.succeed(release, undefined)
    const exit = yield* Fiber.await(slow)
    expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(ClientEvents.SubscriberOverflowError)
    expect(Array.from(yield* Fiber.join(fast))).toHaveLength(4)
  }),
)

it.effect("refuses a TS durable cursor and cleans up scoped listeners", () =>
  Effect.gen(function* () {
    const clients = yield* ClientEvents.Service
    const exit = yield* clients
      .publish({ ...message, durable: { aggregateID: "ses_engine_client", seq: 1, version: 1 } })
      .pipe(Effect.exit)
    expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(ClientEvents.DurableEnvelopeError)
    const received: OpenCodeEvent[] = []
    yield* Effect.scoped(
      Effect.gen(function* () {
        const unsubscribe = yield* clients.listen((event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )
    yield* clients.publish(message)
    expect(received).toHaveLength(0)
  }),
)

const shared = testEffectShared(
  AppNodeBuilder.build(LayerNode.group([ClientEvents.node, EventForwarder.node, Database.node])),
)

shared.live("delivers the same encoded payload to HTTP SSE and TUI without a TS journal row", () =>
  Effect.gen(function* () {
    const clients = yield* ClientEvents.Service
    const database = yield* Database.Service
    const local: GlobalEvent[] = []
    const collect = (event: GlobalEvent) => {
      local.push(event)
    }
    yield* Effect.sync(() => GlobalBus.on("event", collect))
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
    // Reading server.connected proves both bounded subscriptions are installed.
    const connected = yield* Effect.promise(() => reader.read())
    expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
    yield* clients.publish(message)
    const wire = yield* Effect.promise(async () => {
      const decoder = new TextDecoder()
      let body = ""
      while (!body.includes("committed by Rust")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("client event stream closed")
        body += decoder.decode(chunk.value, { stream: true })
      }
      return body
    }).pipe(Effect.timeout("5 seconds"))
    expect(wire).toContain("committed by Rust")
    expect(wire).toContain('"timestamp":123')
    expect(local).toContainEqual(
      expect.objectContaining({
        directory: "/tmp/engine-client",
        payload: expect.objectContaining({
          type: "session.next.text.ended",
          properties: expect.objectContaining({
            timestamp: DateTime.toEpochMillis(DateTime.makeUnsafe(123)),
            text: "committed by Rust",
          }),
        }),
      }),
    )
    expect(local.some((event) => event.payload.type === "sync")).toBe(false)
    const stored = yield* database.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, "ses_engine_client"))
      .all()
    expect(stored).toHaveLength(0)
  }),
)
