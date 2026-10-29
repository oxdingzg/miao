export * as PermissionSource from "./source"

import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { Permission } from "@miao/schema/permission"
import { SessionID } from "@miao/schema/session-id"
import type { PermissionV2 } from "../permission"
import { makeLocationNode } from "../effect/app-node"

type Executor = Pick<PermissionV2.Interface, "ask" | "assert">
type Invocation = { sessionID: SessionID; source?: Permission.Source }

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("PermissionSource.Unavailable", {
  sessionID: SessionID,
  reason: Schema.Literals(["missing_binding", "duplicate_binding"]),
}) {}

export interface Interface {
  readonly get: (input: Invocation) => Effect.Effect<Executor | undefined>
  readonly bind: (input: {
    sessionID: SessionID
    source: Extract<Permission.Source, { type: "tool" }>
    executor: Executor
  }) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@miao/core/PermissionSource") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bindings = new Map<string, Executor>()
    const key = (input: Invocation) =>
      input.source?.type === "tool"
        ? JSON.stringify([input.sessionID, input.source.messageID, input.source.callID])
        : undefined
    yield* Effect.addFinalizer(() => Effect.sync(() => bindings.clear()))
    return Service.of({
      get: (input) =>
        Effect.sync(() => {
          const id = key(input)
          return id === undefined ? undefined : bindings.get(id)
        }),
      bind: (input) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const id = key(input)!
            if (bindings.has(id))
              return yield* Effect.die(new Unavailable({ sessionID: input.sessionID, reason: "duplicate_binding" }))
            bindings.set(id, input.executor)
            return id
          }),
          (id) =>
            Effect.sync(() => {
              if (bindings.get(id) === input.executor) bindings.delete(id)
            }),
        ).pipe(Effect.asVoid),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
