import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { Prompt } from "@miao/core/session/prompt"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionInput } from "@miao/core/session/input"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionStore } from "@miao/core/session/store"
import { SessionMessageTable, SessionTable } from "@miao/core/session/sql"
import { SessionMessage } from "@miao/schema/session-message"
import type { NativeEngine } from "@miao/server/native-engine"
import { AdmissionEngine } from "@/engine/admission"
import type { EngineEvent } from "@/engine/client"
import { projectInputAdmitted } from "@/engine/input-projection"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node])),
)

type Transport = Pick<NativeEngine.Interface, "admit" | "cancelInput" | "storageRoot">

/** An in-memory engine inbox: admits take increasing seqs like `Store::admit`. */
const stubTransport = () => {
  const admits: Array<{ inputID: SessionMessage.ID; delivery: string; seq: number }> = []
  const cancels: SessionMessage.ID[] = []
  let seq = 0
  const transport: Transport = {
    storageRoot: "/engine-root",
    admit: (input) =>
      Effect.sync(() => {
        seq += 1
        const id = input.id ?? SessionMessage.ID.make(`msg_stub_${seq}`)
        admits.push({ inputID: id, delivery: input.delivery ?? "steer", seq })
        return SessionInput.Admitted.make({
          admittedSeq: seq,
          id,
          sessionID: input.sessionID,
          prompt: { text: input.prompt.text },
          delivery: input.delivery ?? "steer",
          timeCreated: DateTime.makeUnsafe(1_000 + seq),
        })
      }),
    cancelInput: (input) =>
      Effect.sync(() => {
        cancels.push(input.inputID)
        return true
      }),
  }
  return { transport, admits, cancels }
}

const setup = Effect.fn("input-projection.setup")(function* (sessionID: SessionV2.ID) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const sessions = yield* SessionStore.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { db, events, sessions }
})

const claimTS = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) => SessionEnginePlacement.claim(db, { sessionID, placement: { engine: "ts" } }))

const claimRust = (sessionID: SessionV2.ID, directory: string) =>
  Database.Service.use(({ db }) =>
    SessionEnginePlacement.claim(db, {
      sessionID,
      placement: {
        engine: "rust",
        storage: AbsolutePath.make(`${directory}/engine.db`),
        location: { directory: AbsolutePath.make(directory) },
      },
    }),
  )

const pending = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) => SessionInput.pending(db, { sessionID, limit: 20 }).pipe(Effect.orDie))

const admittedEvent = (
  sessionID: SessionV2.ID,
  seq: number,
  inputID: SessionMessage.ID,
  delivery: "steer" | "queue",
  prompt: string,
): EngineEvent => ({
  session_id: sessionID,
  seq,
  kind: "input.admitted",
  data: { input_id: inputID, delivery, prompt },
  recorded_at_ms: 1_000 + seq,
})

const visibleUsers = (sessionID: SessionV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.id)),
      ),
  )

const script = ["steer", "queue", "steer"] as const

describe("S2 engine-inbox projection", () => {
  it.effect("admit leaves session_input untouched until the admitted event projects, in engine seq order", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.create()
      const { db, events, sessions } = yield* setup(sessionID)
      yield* claimTS(sessionID)
      const stub = stubTransport()
      const wakes: SessionV2.ID[] = []
      const deps = {
        db,
        events,
        sessions,
        native: stub.transport,
        wake: (id: SessionV2.ID) => Effect.sync(() => wakes.push(id)),
      }

      const first = yield* AdmissionEngine.admit(deps, {
        sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "first" }),
        delivery: "steer",
      })
      const second = yield* AdmissionEngine.admit(deps, {
        sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "second" }),
        delivery: "queue",
      })
      expect(stub.admits.map((admit) => admit.delivery)).toEqual(["steer", "queue"])
      expect(wakes).toEqual([])
      expect((yield* pending(sessionID)).inputs).toEqual([])

      const projection = { db, events, wake: (id: SessionV2.ID) => Effect.sync(() => wakes.push(id)) }
      // One ordered subscription per storage delivers events in engine seq
      // order, so the projection arrives the way the bridge receives it.
      yield* projectInputAdmitted(projection, admittedEvent(sessionID, first.admittedSeq, first.id, "steer", "first"))
      yield* projectInputAdmitted(projection, admittedEvent(sessionID, second.admittedSeq, second.id, "queue", "second"))
      expect(wakes).toEqual([sessionID, sessionID])
      const rows = (yield* pending(sessionID)).inputs
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id])
      expect(rows.map((row) => row.delivery)).toEqual(["steer", "queue"])

      // A replayed admission event is a no-op, never a second row.
      yield* projectInputAdmitted(projection, admittedEvent(sessionID, first.admittedSeq, first.id, "steer", "first"))
      expect((yield* pending(sessionID)).inputs.map((row) => row.id)).toEqual([first.id, second.id])
    }),
  )

  it.effect("native and TS placements promote the same script into the same visible order", () =>
    Effect.gen(function* () {
      const tsSession = SessionV2.ID.create()
      const nativeSession = SessionV2.ID.create()
      const { db, events, sessions } = yield* setup(tsSession)
      // A rust binding must exist before the Session row does: the placement
      // catalog refuses to adopt an existing legacy TS row.
      yield* claimRust(nativeSession, "/engine-native")
      yield* claimTS(tsSession)
      yield* claimRust(nativeSession, "/engine-native")
      const stub = stubTransport()
      const deps = { db, events, sessions, native: stub.transport }

      const admitted: Array<{ id: SessionMessage.ID; seq: number; delivery: "steer" | "queue"; text: string }> = []
      for (const sessionID of [tsSession, nativeSession]) {
        for (const [index, delivery] of script.entries()) {
          const text = `${delivery}-${index}`
          const receipt = yield* AdmissionEngine.admit(deps, {
            sessionID,
            id: SessionMessage.ID.create(),
            prompt: Prompt.make({ text }),
            delivery,
          })
          if (sessionID === tsSession) admitted.push({ id: receipt.id, seq: receipt.admittedSeq, delivery, text })
        }
      }
      expect(stub.admits).toHaveLength(script.length * 2)

      // The engine inbox feeds the TS projection only: nothing was written
      // before the events arrived, so every row traces to one projection.
      expect((yield* pending(tsSession)).inputs).toEqual([])
      for (const input of admitted) {
        yield* projectInputAdmitted(
          { db, events },
          admittedEvent(tsSession, input.seq, input.id, input.delivery, input.text),
        )
      }
      expect((yield* pending(tsSession)).inputs).toHaveLength(script.length)

      // promote_tx: every pending steer in admitted_seq order, then one queue
      // once the Session would otherwise go idle. The TS drain must reproduce
      // exactly that visible order from the projected rows.
      const engineOrder = [
        ...admitted.filter((input) => input.delivery === "steer").map((input) => input.id),
        ...admitted.filter((input) => input.delivery === "queue").map((input) => input.id),
      ]
      expect(yield* SessionInput.promoteSteers(db, events, tsSession, Number.MAX_SAFE_INTEGER)).toEqual(
        admitted.filter((input) => input.delivery === "steer").length,
      )
      expect(yield* SessionInput.promoteNextQueued(db, events, tsSession)).toBe(true)
      expect(yield* SessionInput.promoteNextQueued(db, events, tsSession)).toBe(false)
      expect((yield* pending(tsSession)).inputs).toEqual([])
      expect(yield* visibleUsers(tsSession)).toEqual(engineOrder)
    }),
  )

  it.effect("MIAO_INPUT_TS_ADMIT=1 restores the pre-S2 writer and the engine path drains after switching back", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.create()
      const { db, events, sessions } = yield* setup(sessionID)
      yield* claimTS(sessionID)
      const stub = stubTransport()
      const deps = { db, events, sessions, native: stub.transport }

      let legacyID: SessionMessage.ID | undefined
      process.env.MIAO_INPUT_TS_ADMIT = "1"
      try {
        const legacy = yield* AdmissionEngine.admit(deps, {
          sessionID,
          id: SessionMessage.ID.create(),
          prompt: Prompt.make({ text: "legacy" }),
          delivery: "steer",
        })
        legacyID = legacy.id
        expect(stub.admits).toEqual([])
        expect((yield* pending(sessionID)).inputs.map((row) => row.id)).toEqual([legacy.id])
      } finally {
        delete process.env.MIAO_INPUT_TS_ADMIT
      }

      const engine = yield* AdmissionEngine.admit(deps, {
        sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "engine" }),
        delivery: "steer",
      })
      expect(stub.admits.map((admit) => admit.inputID)).toEqual([engine.id])
      expect((yield* pending(sessionID)).inputs.map((row) => row.id)).toEqual([legacyID])
      yield* projectInputAdmitted(
        { db, events },
        admittedEvent(sessionID, engine.admittedSeq, engine.id, "steer", "engine"),
      )
      expect(yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)).toBe(2)
      expect((yield* pending(sessionID)).inputs).toEqual([])
    }),
  )

  it.effect("engine-path cancel vetoes the engine row and drops the projection", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.create()
      const { db, events, sessions } = yield* setup(sessionID)
      yield* claimTS(sessionID)
      const stub = stubTransport()
      const deps = { db, events, sessions, native: stub.transport }
      const projection = { db, events }

      const receipt = yield* AdmissionEngine.admit(deps, {
        sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "cancel me" }),
        delivery: "steer",
      })
      yield* projectInputAdmitted(
        projection,
        admittedEvent(sessionID, receipt.admittedSeq, receipt.id, "steer", "cancel me"),
      )
      expect((yield* pending(sessionID)).inputs).toHaveLength(1)

      expect(yield* AdmissionEngine.cancel(deps, { sessionID, id: receipt.id })).toBe(true)
      expect(stub.cancels).toEqual([receipt.id])
      expect((yield* pending(sessionID)).inputs).toEqual([])
    }),
  )
})
