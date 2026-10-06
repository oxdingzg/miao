import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { ProjectV2 } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionLease } from "@miao/core/session/lease"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionTodo } from "@miao/core/session/todo"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

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

describe("SessionLease", () => {
  it.effect("fences a stale holder by epoch and by deadline", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* (yield* SessionV2.Service).create({ location })
      const now = 1_000
      const ttl = 100

      const first = yield* SessionLease.acquire(db, {
        sessionID: session.id,
        holder: "worker-a",
        build: "build-a",
        now,
        ttl,
      })
      expect(first).toMatchObject({ epoch: 1, holder: "worker-a", build: "build-a" })

      // A live holder keeps it: acquisition cannot steal, and a stale epoch
      // cannot renew or release.
      expect(
        yield* SessionLease.acquire(db, { sessionID: session.id, holder: "worker-b", build: "build-b", now, ttl }),
      ).toBeUndefined()
      expect(yield* SessionLease.holds(db, { sessionID: session.id, holder: "worker-a", epoch: 1, now })).toBe(true)
      expect(
        yield* SessionLease.renew(db, { sessionID: session.id, holder: "worker-a", epoch: 2, now, ttl }),
      ).toBe(false)
      expect(yield* SessionLease.release(db, { sessionID: session.id, holder: "worker-a", epoch: 2 })).toBe(false)

      // Past the deadline a peer takes it; the epoch advances, fencing worker-a.
      const stolen = yield* SessionLease.acquire(db, {
        sessionID: session.id,
        holder: "worker-b",
        build: "build-b",
        now: now + ttl + 1,
        ttl,
      })
      expect(stolen).toMatchObject({ epoch: 2, holder: "worker-b", build: "build-b" })
      expect(
        yield* SessionLease.holds(db, { sessionID: session.id, holder: "worker-a", epoch: 1, now: now + ttl + 1 }),
      ).toBe(false)
      expect(
        yield* SessionLease.renew(db, { sessionID: session.id, holder: "worker-b", epoch: 2, now: now + ttl + 1, ttl }),
      ).toBe(true)
      expect(yield* SessionLease.holder(db, session.id)).toMatchObject({ holder: "worker-b", epoch: 2 })

      expect(yield* SessionLease.release(db, { sessionID: session.id, holder: "worker-b", epoch: 2 })).toBe(true)
      expect(yield* SessionLease.holder(db, session.id)).toBeUndefined()
    }),
  )
})

test("an execution worker opens the owned database as a participant", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "runtime.sqlite")
  await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* Database.Service
      // The owner holds the storage lock and has migrated. The participant must
      // still open the same file, without the lock and without migrating.
      const participant = yield* Database.Service.pipe(
        Effect.provide(Database.participantLayerFromPath(filename)),
        Effect.scoped,
      )
      expect(participant.db).not.toBe(owner.db)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
})
