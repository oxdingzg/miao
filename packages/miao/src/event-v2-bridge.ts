// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventForwarder } from "@/server/event-forwarder"
import { EventV2 } from "@miao/core/event"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@miao/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* EventForwarder.Service

    return Service.of(events)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node, EventForwarder.node] })

export * as EventV2Bridge from "./event-v2-bridge"
