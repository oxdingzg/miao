export * as WorkspaceV2Bridge from "./workspace-v2"

import { LayerNode } from "@miao/core/effect/layer-node"
import { WorkspaceV2 } from "@miao/core/workspace"
import { SessionV2 } from "@miao/core/session"
import { Cause, Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { listAdapters } from "./adapters"
import { Workspace } from "./workspace"

function toUnsupported<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchCause((cause) => {
      const die = cause.reasons.find(Cause.isDieReason)
      const fail = cause.reasons.find(Cause.isFailReason)
      const reason: unknown = die?.defect ?? fail?.error
      const message = reason instanceof Error ? reason.message : String(reason ?? "Workspace operation failed")
      return Effect.fail(new WorkspaceV2.UnsupportedError({ message }))
    }),
  )
}

const layer = Layer.effect(
  WorkspaceV2.Service,
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    const resolve = (scope: WorkspaceV2.Scope) => project.get(scope.projectID)

    return WorkspaceV2.Service.of({
      list: (scope) =>
        resolve(scope).pipe(Effect.flatMap((info) => (info ? workspace.list(info) : Effect.succeed([])))),
      status: (scope) =>
        Effect.gen(function* () {
          const info = yield* resolve(scope)
          if (!info) return []
          const ids = new Set((yield* workspace.list(info)).map((item) => item.id))
          return (yield* workspace.status()).filter((item) => ids.has(item.workspaceID))
        }),
      adapters: (scope) => Effect.sync(() => listAdapters(scope.projectID)),
      create: (input, scope) =>
        toUnsupported(
          store.provide(
            { directory: scope.directory },
            workspace.create({ ...input, projectID: scope.projectID, extra: input.extra ?? null }),
          ),
        ),
      remove: (id, scope) => toUnsupported(store.provide({ directory: scope.directory }, workspace.remove(id))),
      syncList: (scope) =>
        toUnsupported(
          Effect.gen(function* () {
            const info = yield* resolve(scope)
            if (!info) return
            yield* store.provide({ directory: scope.directory }, workspace.syncList(info))
          }),
        ),
      warp: (input, scope) =>
        toUnsupported(
          store.provide(
            { directory: scope.directory },
            workspace.sessionWarp({
              workspaceID: input.id,
              sessionID: SessionV2.ID.make(input.sessionID),
              copyChanges: input.copyChanges,
            }),
          ),
        ),
    })
  }),
)

export const node = LayerNode.make({
  service: WorkspaceV2.Service,
  layer,
  deps: [Workspace.node, Project.node, InstanceStore.node],
})
