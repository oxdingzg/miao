import { expect } from "bun:test"
import path from "node:path"
import { sql } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { EventV2 } from "@miao/core/event"
import { EventTable } from "@miao/core/event/sql"
import { SessionEvent } from "@miao/core/session/event"
import { Database } from "@miao/core/database/database"
import { SessionMessage } from "@miao/core/session/message"
import { SessionSchema } from "@miao/core/session/schema"
import { SessionToolDispatch } from "@miao/core/session/tool-dispatch"
import { SessionToolDispatchTable } from "@miao/core/session/sql"
import { it, testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionSchema.ID.make("ses_dispatch_fence")
const call = { tool: "write", input: { text: "once" } }
const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.run(
    sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('dispatch-project', '/', '[]', 0, 0)`,
  )
  yield* database.db.run(
    sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${sessionID}, 'dispatch-project', 'dispatch', '/', 'dispatch', 'test', 0, 0)`,
  )
})
const token = () =>
  SessionToolDispatch.token({ sessionID, assistantMessageID: SessionMessage.ID.create(), callID: "same-call" })
const memory = testEffect(Database.layerFromPath(":memory:"))
const transactional = testEffect(EventV2.layerWith().pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))))

transactional.live("a failed Tool.Called commit leaves neither a dispatch plan nor a durable call event", () =>
  Effect.gen(function* () {
    yield* seed
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const attempt = token()
    const exit = yield* events
      .publish(
        SessionEvent.Tool.Called,
        {
          sessionID,
          assistantMessageID: attempt.assistantMessageID,
          callID: attempt.callID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          ...call,
          provider: { executed: false },
        },
        {
          commit: () =>
            SessionToolDispatch.plan(database.db, attempt, call).pipe(
              Effect.orDie,
              Effect.andThen(Effect.die("abort dispatch commit")),
            ),
        },
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* database.db.select().from(SessionToolDispatchTable).all()).toEqual([])
    expect(yield* database.db.select().from(EventTable).all()).toEqual([])
    expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, attempt).pipe(Effect.exit))).toBe(true)
  }),
)

memory.live("one token permits one dispatch and cannot be reminted, forged or consumed after settlement", () =>
  Effect.gen(function* () {
    yield* seed
    const database = yield* Database.Service
    const attempt = token()
    yield* SessionToolDispatch.plan(database.db, attempt, call)
    expect(
      Exit.isFailure(yield* SessionToolDispatch.consume(database.db, { ...attempt, id: "forged" }).pipe(Effect.exit)),
    ).toBe(true)
    const consumed = yield* Effect.all(
      [
        SessionToolDispatch.consume(database.db, attempt).pipe(Effect.exit),
        SessionToolDispatch.consume(database.db, attempt).pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    )
    expect(consumed.filter(Exit.isSuccess)).toHaveLength(1)
    expect(consumed.filter(Exit.isFailure)).toHaveLength(1)
    yield* SessionToolDispatch.settle(database.db, attempt)
    expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, attempt).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* SessionToolDispatch.plan(database.db, { ...attempt, id: "replacement" }, call).pipe(Effect.exit),
      ),
    ).toBe(true)
    const laterTurn = token()
    yield* SessionToolDispatch.plan(database.db, laterTurn, call)
    yield* SessionToolDispatch.consume(database.db, laterTurn)
    expect(
      yield* database.db.select({ status: SessionToolDispatchTable.status }).from(SessionToolDispatchTable).all(),
    ).toEqual([{ status: "settled" }, { status: "dispatched" }])
  }),
)

memory.live("recovery retires unconsumed plans and never restores uncertain dispatch authority", () =>
  Effect.gen(function* () {
    yield* seed
    const database = yield* Database.Service
    const pending = token()
    const running = token()
    yield* SessionToolDispatch.plan(database.db, pending, call)
    yield* SessionToolDispatch.plan(database.db, running, call)
    yield* SessionToolDispatch.consume(database.db, running)
    yield* SessionToolDispatch.recover(database.db, sessionID)
    yield* SessionToolDispatch.recover(database.db, sessionID)
    yield* SessionToolDispatch.settle(database.db, running)
    expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, pending).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, running).pipe(Effect.exit))).toBe(true)
    expect(
      yield* database.db.select({ status: SessionToolDispatchTable.status }).from(SessionToolDispatchTable).all(),
    ).toEqual([{ status: "cancelled" }, { status: "unknown" }])
  }),
)

it.live("a real process dies after an fsynced side effect; reopen fences that attempt but permits a new turn", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(Effect.promise(tmpdir), (directory) =>
      Effect.promise(() => directory[Symbol.asyncDispose]()),
    )
    const filename = path.join(directory.path, "dispatch.db")
    const sideEffect = path.join(directory.path, "side-effect.txt")
    const attempt = token()
    yield* seed.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(
          [
            process.execPath,
            path.join(import.meta.dirname, "fixture/tool-dispatch-crash.ts"),
            filename,
            sideEffect,
            JSON.stringify(attempt),
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      ),
      (child) =>
        Effect.sync(() => {
          if (child.exitCode === null) child.kill()
        }),
    )
    expect(yield* Effect.promise(() => child.exited)).toBe(71)
    expect(yield* Effect.promise(() => Bun.file(sideEffect).text())).toBe("once\n")
    yield* Effect.gen(function* () {
      const database = yield* Database.Service
      yield* SessionToolDispatch.recover(database.db, sessionID)
      expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, attempt).pipe(Effect.exit))).toBe(true)
      expect(
        yield* database.db.select({ status: SessionToolDispatchTable.status }).from(SessionToolDispatchTable).all(),
      ).toEqual([{ status: "unknown" }])
      const laterTurn = token()
      yield* SessionToolDispatch.plan(database.db, laterTurn, call)
      yield* SessionToolDispatch.consume(database.db, laterTurn)
      yield* Effect.promise(() => Bun.write(sideEffect, "once\nonce\n"))
      yield* SessionToolDispatch.settle(database.db, laterTurn)
      expect(Exit.isFailure(yield* SessionToolDispatch.consume(database.db, laterTurn).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
    expect(yield* Effect.promise(() => Bun.file(sideEffect).text())).toBe("once\nonce\n")
  }),
)
