export * as EventForwarder from "./event-forwarder"

import { EventV2 } from "@miao/core/event"
import { Effect, Layer, Context } from "effect"
import { makeGlobalNode } from "@miao/core/effect/app-node"
import { GlobalBus } from "@/bus/global"

/**
 * Relays every EventV2 event onto the process-local GlobalBus so the in-process
 * TUI worker can forward it over RPC, mirroring what `/api/event` streams to
 * attached clients. The TUI route construction yields this service, so the
 * subscription is installed whenever the server assembly is built.
 */
export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@miao/EventForwarder") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? "global",
          ...(event.location?.workspaceID ? { workspace: event.location.workspaceID } : {}),
          payload: { id: event.id, type: event.type, properties: EventV2.encodeData(event) },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({})
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
