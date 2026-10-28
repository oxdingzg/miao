import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionStore } from "@miao/core/session/store"
import { SessionTodo } from "@miao/core/session/todo"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionTodo.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("SessionV2.pin", () => {
  it.effect("puts a pinned Session above the recently updated ones", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const older = yield* session.create({ location })
      const newer = yield* session.create({ location })
      // Both were just created, so the default order is decided by the ID
      // tiebreak; pinning one has to outrank that.
      const before = yield* session.list()
      expect(before.map((row) => row.id)).toContain(older.id)
      expect(before.map((row) => row.id)).toContain(newer.id)

      yield* session.pin({ sessionID: older.id, pinned: true })

      const pinned = yield* session.list()
      expect(pinned[0]?.id).toBe(older.id)
      expect(pinned[0]?.time.pinned).toBeDefined()
      expect(pinned.at(-1)?.time.pinned).toBeUndefined()
    }),
  )

  it.effect("keeps the pinned lead in ascending order too", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const first = yield* session.create({ location })
      yield* session.create({ location })

      yield* session.pin({ sessionID: first.id, pinned: true })

      const pinned = yield* session.list({ order: "asc" })
      expect(pinned[0]?.id).toBe(first.id)
    }),
  )

  it.effect("removes the Session from the lead when it is unpinned", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const pinned = yield* session.create({ location })
      yield* session.create({ location })

      yield* session.pin({ sessionID: pinned.id, pinned: true })
      expect((yield* session.list())[0]?.id).toBe(pinned.id)

      yield* session.pin({ sessionID: pinned.id, pinned: false })

      const unpinned = yield* session.list()
      expect(unpinned.some((row) => row.time.pinned !== undefined)).toBe(false)
      // The Session itself is untouched; only its place in the list changed.
      expect(unpinned.map((row) => row.id)).toContain(pinned.id)
    }),
  )

  it.effect("reports a pin against a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      expect(
        yield* session.pin({ sessionID: SessionV2.ID.create(), pinned: true }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
