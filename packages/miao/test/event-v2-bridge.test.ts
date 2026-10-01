import { expect } from "bun:test"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionEvent } from "@miao/schema/session-event"
import { Effect, Schema } from "effect"
import { GlobalBus, type GlobalEvent } from "../src/bus/global"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([EventV2Bridge.node])))

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
  }),
)
