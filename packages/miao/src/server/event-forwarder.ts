export * as EventForwarder from "./event-forwarder"

import { EventV2 } from "@miao/core/event"
import { ClientEvents } from "@miao/server/client-events"
import { Effect, Layer, Context } from "effect"
import { makeGlobalNode } from "@miao/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"

/**
 * Relays every EventV2 event onto the process-local GlobalBus so the in-process
 * TUI worker can forward it over RPC, mirroring what `/api/event` streams to
 * attached clients. Both the server assembly and legacy publish bridge use
 * this shared subscription; separate listeners would append stream deltas twice.
 */
export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@miao/EventForwarder") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const clients = yield* ClientEvents.Service
    const forward: EventV2.Subscriber = (event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        // The worker serializes GlobalBus payloads, so encode dates and other
        // schema values once for both live and durable sync envelopes.
        const data = EventV2.encodeData(event)
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory ?? "global",
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory ?? "global",
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data,
            },
          },
        })
      })
    const unsubscribe = yield* events.listen(forward)
    const unsubscribeClients = yield* clients.listen(forward)
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(unsubscribeClients)))
    return Service.of({})
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, ClientEvents.node] })
