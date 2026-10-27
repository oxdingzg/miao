import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { AbsolutePath } from "@miao/core/schema"
import { SessionCreate } from "@miao/core/session-create"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionID } from "@miao/schema/session-id"
import { projectSubagentStarted } from "@/engine/subagent-projection"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionCreate.node]),
  ),
)

const location = { directory: AbsolutePath.make("/workspace") }
const storage = AbsolutePath.make("/engine/native.db")

/** The engine's `subagent_start`, as the parent Session's journal carries it. */
const started = (parent: string, child: string, agent?: string) => ({
  session_id: parent,
  seq: 1,
  kind: "subagent_start",
  data: {
    run_id: "run_1",
    subagent_id: child,
    call_id: "call_1",
    background: false,
    description: "explore",
    ...(agent === undefined ? {} : { agent }),
  },
})

it.effect("a delegated child is bound to the parent's storage and Location", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const creation = yield* SessionCreate.Service
    const sessions = yield* SessionStore.Service
    const parent = yield* creation.create({ id: SessionID.make("ses_parent"), location, nativeStorage: storage })
    const deps = { db: database.db, create: creation.create }

    expect(yield* projectSubagentStarted(deps, started(parent.id, "ses_parent/sub-child", "explore"))).toBe(true)

    const child = yield* SessionEnginePlacement.find(database.db, SessionID.make("ses_parent/sub-child"))
    expect(child).toEqual({ engine: "rust", storage, location })
    // The binding is what makes the child reachable: the recorded Session is
    // what a listing, a route, and `children()` read.
    expect((yield* sessions.get(SessionID.make("ses_parent/sub-child")))?.parentID).toBe(parent.id)

    // A replayed event must not re-record, and the caller learns it did nothing.
    expect(yield* projectSubagentStarted(deps, started(parent.id, "ses_parent/sub-child", "explore"))).toBe(false)
  }),
)

it.effect("a TypeScript-owned parent records nothing: its product tool already did", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const creation = yield* SessionCreate.Service
    yield* creation.create({ id: SessionID.make("ses_ts_parent"), location })

    expect(
      yield* projectSubagentStarted(
        { db: database.db, create: creation.create },
        started("ses_ts_parent", "ses_ts_parent/sub-child"),
      ),
    ).toBe(false)
    expect(yield* SessionEnginePlacement.find(database.db, SessionID.make("ses_ts_parent/sub-child"))).toBeUndefined()
  }),
)

it.effect("an existing binding wins over the event's facts", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const creation = yield* SessionCreate.Service
    const binding = AbsolutePath.make("/engine/elsewhere.db")
    yield* creation.create({ id: SessionID.make("ses_other"), location, nativeStorage: binding })
    yield* creation.create({ id: SessionID.make("ses_other/sub-child"), location, nativeStorage: binding })

    expect(
      yield* projectSubagentStarted(
        { db: database.db, create: creation.create },
        started("ses_other", "ses_other/sub-child"),
      ),
    ).toBe(false)
    expect(yield* SessionEnginePlacement.find(database.db, SessionID.make("ses_other/sub-child"))).toEqual({
      engine: "rust",
      storage: binding,
      location,
    })
  }),
)
