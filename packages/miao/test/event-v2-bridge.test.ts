import { expect } from "bun:test"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionEvent } from "@miao/schema/session-event"
import { Effect, Schema } from "effect"
import { GlobalBus, type GlobalEvent } from "../src/bus/global"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { EventForwarder } from "../src/server/event-forwarder"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([EventV2Bridge.node])))
const combined = testEffect(LayerNode.compile(LayerNode.group([EventV2Bridge.node, EventForwarder.node])))

const wire = {
  timestamp: 1790896908000,
  sessionID: "ses_f07d6a8cdffeiDL9G9KnxY57A7",
  messageID: "msg_0f9c622cf001RJOTYGNaJgS7mV",
  prompt: { text: "status?" },
  delivery: "steer",
}

// The TUI worker and SSE clients receive GlobalBus payloads through
// JSON.stringify; a decoded DateTime used to arrive as an ISO string and made
// the TUI turn timer print "NaNd NaNh".
it.live("emits event data to the global bus in wire form", () =>
  Effect.gen(function* () {
    const emitted: GlobalEvent[] = []
    const listener = (event: GlobalEvent) => emitted.push(event)
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

    const events = yield* EventV2Bridge.Service
    yield* events.publish(SessionEvent.Prompted, Schema.decodeUnknownSync(SessionEvent.Prompted.data)(wire))

    const payloads = emitted.map((event) => JSON.parse(JSON.stringify(event.payload)))
    expect(payloads.find((payload) => payload.type === SessionEvent.Prompted.type)?.properties).toEqual(wire)
    expect(payloads.find((payload) => payload.type === "sync")?.syncEvent.data).toEqual(wire)
    expect(payloads.filter((payload) => payload.type === SessionEvent.Prompted.type)).toHaveLength(1)
    expect(payloads.filter((payload) => payload.type === "sync")).toHaveLength(1)
  }),
)

combined.live("forwards each stream fragment once when the bridge and server forwarder are both active", () =>
  Effect.gen(function* () {
    const emitted: GlobalEvent[] = []
    const listener = (event: GlobalEvent) => emitted.push(event)
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

    const events = yield* EventV2Bridge.Service
    yield* EventForwarder.Service
    const fragment = Schema.decodeUnknownSync(SessionEvent.Text.Delta.data)({
      timestamp: wire.timestamp,
      sessionID: wire.sessionID,
      assistantMessageID: wire.messageID,
      textID: "text_stream",
      delta: "统计",
    })
    const first = yield* events.publish(SessionEvent.Text.Delta, fragment)
    const second = yield* events.publish(SessionEvent.Text.Delta, fragment)
    expect(emitted.filter((event) => event.payload.id === first.id)).toHaveLength(1)
    expect(emitted.filter((event) => event.payload.id === second.id)).toHaveLength(1)
    expect(emitted.map((event) => event.payload.properties.delta).join("")).toBe("统计统计")
    const durable = yield* events.publish(
      SessionEvent.Prompted,
      Schema.decodeUnknownSync(SessionEvent.Prompted.data)(wire),
    )
    const copies = emitted.filter((event) => event.payload.id === durable.id)
    expect(copies.filter((event) => event.payload.type === SessionEvent.Prompted.type)).toHaveLength(1)
    expect(copies.filter((event) => event.payload.type === "sync")).toHaveLength(1)
  }),
)
