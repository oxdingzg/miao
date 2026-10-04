export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@miao/schema/session"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@miao/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionHistory } from "./session/history"
import { SessionMessageTable, SessionTable, TodoTable } from "./session/sql"
import { ProjectTable } from "./project/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionV1 } from "./v1/session"
import { AppProcess } from "./process"
import { ChildProcess } from "effect/unstable/process"
import { SessionTodo } from "./session/todo"
import { SessionCreate } from "./session-create"
import { SessionDiff } from "./session/diff"
import { SessionFork } from "./session/fork"
import { SessionCommand } from "./session/command"
import { CommandV2 } from "./command"
import { SkillV2 } from "./skill"
import { SessionCompactRequest } from "./session/compact-request"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { LegacyNotMigratedError, MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@miao/schema/revert"
import { FSUtil } from "./fs-util"
import { Blob } from "./blob"
import { SessionBlobStorage } from "./session/blob-storage"
import { materializeBlobRefs, materializeEvent, materializePrompt } from "./session/runner/materialize-files"
import { SessionDurable } from "@miao/schema/durable-event-manifest"
import { EventSequenceTable, EventTable } from "./event/sql"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
  roots: Schema.Boolean.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

type MessagesPageInput = {
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly cursor?: { readonly id: SessionMessage.ID; readonly direction: "previous" | "next" }
}

// Legacy messages have no projected sequence. This mirrors the seq-based
// pagination of `SessionV2.messages` over the ordered legacy list so an
// un-migrated session reads the same through the API as through `context`.
const paginateLegacy = (messages: ReadonlyArray<SessionMessage.Message>, input: MessagesPageInput) => {
  const cursor = input.cursor
  const direction = cursor?.direction ?? "next"
  const requestedOrder = input.order ?? "desc"
  const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
  const ordered = order === "asc" ? messages : messages.toReversed()
  const index = cursor === undefined ? -1 : messages.findIndex((message) => message.id === cursor.id)
  if (cursor !== undefined && index < 0) return []
  const offset = cursor === undefined ? 0 : order === "asc" ? index + 1 : messages.length - index
  const page = ordered.slice(offset, input.limit === undefined ? undefined : offset + input.limit)
  return direction === "previous" ? page.toReversed() : page
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, LegacyNotMigratedError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | LegacyNotMigratedError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly todo: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionTodo.Info>, NotFoundError>
  readonly children: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<SessionSchema.Info>, NotFoundError>
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly type: "idle" | "busy" }, NotFoundError>
  readonly inputs: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ inputs: ReadonlyArray<SessionInput.Admitted>; hasMore: boolean }, NotFoundError>
  /** Files changed since the Session's first snapshot, or within one user turn when `messageID` names it. */
  readonly diff: (
    sessionID: SessionSchema.ID,
    options?: { readonly messageID?: SessionMessage.ID },
  ) => Effect.Effect<ReadonlyArray<typeof Revert.FileDiff.Type>, NotFoundError>
  readonly fork: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | LegacyNotMigratedError>
  readonly command: (input: {
    sessionID: SessionSchema.ID
    command: string
    arguments: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | LegacyNotMigratedError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly archive: (input: { sessionID: SessionSchema.ID; archived: boolean }) => Effect.Effect<void, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError | LegacyNotMigratedError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | LegacyNotMigratedError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError | LegacyNotMigratedError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | LegacyNotMigratedError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | LegacyNotMigratedError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<void, NotFoundError | OperationUnavailableError | LegacyNotMigratedError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly executions: Effect.Effect<ReadonlyMap<SessionSchema.ID, string>>
  readonly interruptIf: (sessionID: SessionSchema.ID, execution: string) => Effect.Effect<boolean>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const creation = yield* SessionCreate.Service
    const appProcess = yield* AppProcess.Service
    const locations = yield* LocationServiceMap.Service
    const blob = yield* Blob.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const runShell = (session: SessionSchema.Info, command: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const result = yield* appProcess.run(
          ChildProcess.make(command, [], {
            cwd: session.location.directory,
            shell: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
          { combineOutput: true },
        )
        return (result.output ?? Buffer.alloc(0)).toString()
      }).pipe(Effect.orElseSucceed(() => ""))

    // V2 writes must not touch a session whose history is still legacy-only, or
    // the projection and the legacy tables would mix with no safe ordering.
    const requireMigrated = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const state = yield* store.historyState(sessionID)
      if (state === "legacy" || state === "mixed") return yield* new LegacyNotMigratedError({ sessionID, state })
    })

    // The TUI re-hydrates on every live event and re-requests `session.diff`,
    // which reads the whole durable log and captures a fresh worktree snapshot.
    // Serving a cached diff until the durable log advances keeps the view live
    // without re-snapshotting the worktree several times a second. The short TTL
    // still picks up worktree edits that arrive without a durable event.
    const diffCache = new Map<string, { seq: number; at: number; result: ReadonlyArray<typeof Revert.FileDiff.Type> }>()
    const diffCacheTTL = 2_000
    const diffCacheLimit = 32

    const result = Service.of({
      create: Effect.fn("V2Session.create")((input) => creation.create(input)),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.roots) conditions.push(isNull(SessionTable.parent_id))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const state = yield* store.historyState(input.sessionID)
        // Un-migrated (or stranded) legacy history has no projection to page
        // over, so read it through the same fallback `context` uses.
        if (state === "legacy" || state === "mixed") {
          const legacy = yield* store.context(input.sessionID)
          return paginateLegacy(yield* materializeBlobRefs(blob, legacy), input)
        }
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        const ordered = direction === "previous" ? rows.toReversed() : rows
        return yield* materializeBlobRefs(blob, yield* Effect.forEach(ordered, decode))
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        if (stored?.sessionID !== input.sessionID) return undefined
        const [message] = yield* materializeBlobRefs(blob, [stored.message])
        return message
      }),
      todo: Effect.fn("V2Session.todo")(function* (sessionID) {
        yield* result.get(sessionID)
        const rows = yield* db
          .select()
          .from(TodoTable)
          .where(eq(TodoTable.session_id, sessionID))
          .orderBy(asc(TodoTable.position))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({ content: row.content, status: row.status, priority: row.priority }))
      }),
      children: Effect.fn("V2Session.children")(function* (sessionID) {
        yield* result.get(sessionID)
        const rows = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, sessionID))
          .orderBy(asc(SessionTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      }),
      status: Effect.fn("V2Session.status")(function* (sessionID) {
        yield* result.get(sessionID)
        const active = yield* execution.active
        return { type: active.has(sessionID) ? ("busy" as const) : ("idle" as const) }
      }),
      rename: Effect.fn("V2Session.rename")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Info.Updated, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          title: input.title,
        })
      }),
      archive: Effect.fn("V2Session.archive")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Info.Updated, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          archived: input.archived,
        })
      }),
      remove: Effect.fn("V2Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        yield* events.remove(sessionID)
        SessionProjector.forget(db)
        SessionHistory.invalidate(db)
      }),
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* requireMigrated(session.id)
        const command = yield* Effect.gen(function* () {
          const commands = yield* CommandV2.Service
          return yield* commands.get(input.command)
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.orElseSucceed(() => undefined),
        )
        if (command === undefined) return yield* new NotFoundError({ sessionID: input.sessionID })
        const text = SessionCommand.renderTemplate(command.template, input.arguments)
        if (command.agent !== undefined)
          yield* events.publish(SessionEvent.AgentSwitched, {
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            agent: command.agent,
          })
        if (command.model !== undefined)
          yield* events.publish(SessionEvent.ModelSwitched, {
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            model: command.model,
          })
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: session.id,
          prompt: Prompt.make({ text }),
          delivery: "steer",
        })
        // `/init` writes the project's AGENTS.md; record when the project was set up.
        if (input.command === "init")
          yield* db
            .update(ProjectTable)
            .set({ time_initialized: Date.now() })
            .where(eq(ProjectTable.id, session.projectID))
            .run()
            .pipe(Effect.orDie)
        if (input.resume !== false) yield* execution.wake(session.id)
      }),
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        yield* requireMigrated(parent.id)
        const child = yield* creation.create({
          parentID: input.sessionID,
          agent: parent.agent,
          location: parent.location,
        })
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, input.sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        // Backfilled legacy history has no EventV2 rows, so replay cannot
        // reproduce it. It lives in the projection at a negative sequence.
        const legacyRows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, parent.id), lt(SessionMessageTable.seq, 0)))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        const legacyCutoff =
          input.messageID === undefined ? -1 : legacyRows.findIndex((row) => row.id === input.messageID)
        let cutoff: number | undefined
        if (input.messageID !== undefined) {
          const target = rows.find((row) => {
            const data = row.data as Record<string, unknown>
            return data?.messageID === input.messageID || data?.assistantMessageID === input.messageID
          })
          // A cutoff at a legacy message stops before any event.
          cutoff = legacyCutoff >= 0 ? -1 : (target?.seq ?? rows.at(-1)?.seq)
        }
        const allowed = new Set(SessionDurable.definitions.keys())
        // The child owns its own Session info; never replay the parent's
        // creation or info updates under the child aggregate.
        allowed.delete(
          EventV2.versionedType(SessionEvent.Info.Created.type, SessionEvent.Info.Created.durable?.version ?? 1),
        )
        allowed.delete(
          EventV2.versionedType(SessionEvent.Info.Updated.type, SessionEvent.Info.Updated.durable?.version ?? 1),
        )
        const sequence = yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, child.id))
          .get()
          .pipe(Effect.orDie)
        let seq = (sequence?.seq ?? -1) + 1
        const remapped = new Map<string, string>()
        const next = (old: string) => {
          const existing = remapped.get(old)
          if (existing !== undefined) return existing
          const created = SessionMessage.ID.create()
          remapped.set(old, created)
          return created
        }
        for (const row of rows) {
          if (!allowed.has(row.type)) continue
          if (cutoff !== undefined && row.seq > cutoff) break
          const data = SessionFork.remapEventData(row.data, next) as Record<string, unknown>
          yield* events
            .replay(
              {
                id: EventV2.ID.create(),
                type: row.type,
                aggregateID: child.id,
                seq,
                data: { ...data, sessionID: child.id },
              },
              { publish: true },
            )
            .pipe(Effect.catchCause(() => Effect.void))
          seq += 1
        }
        if (legacyRows.length > 0) {
          const included = legacyCutoff >= 0 ? legacyRows.slice(0, legacyCutoff + 1) : legacyRows
          let legacySeq = -included.length
          for (const row of included) {
            yield* db
              .insert(SessionMessageTable)
              .values({
                id: SessionMessage.ID.create(),
                session_id: child.id,
                type: row.type,
                seq: legacySeq,
                time_created: row.time_created,
                data: row.data,
              })
              .run()
              .pipe(Effect.orDie)
            legacySeq += 1
          }
        }
        return child
      }),
      diff: Effect.fn("V2Session.diff")(function* (sessionID, options) {
        const session = yield* result.get(sessionID)
        const cacheKey = options?.messageID ? `${sessionID}:${options.messageID}` : sessionID
        return yield* Effect.gen(function* () {
          const seq = yield* EventV2.latestSequence(db, sessionID)
          const cached = diffCache.get(cacheKey)
          if (cached && cached.seq === seq && Date.now() - cached.at < diffCacheTTL) return cached.result
          const snapshots = yield* Snapshot.Service
          const history = yield* EventV2.readAggregate(db, {
            aggregateID: sessionID,
            manifest: SessionDurable,
            after: 0,
            limit: 100_000,
          })
          const bounds = options?.messageID
            ? SessionDiff.turnSnapshots(history.events, options.messageID)
            : { from: SessionDiff.baselineSnapshot(history.events), to: undefined }
          if (bounds?.from === undefined) {
            diffCache.set(cacheKey, { seq, at: Date.now(), result: [] })
            return []
          }
          // A finished turn ends at its last step snapshot; an open turn or the
          // whole Session compares against the live worktree.
          const current = bounds.to === undefined ? yield* snapshots.capture() : Snapshot.ID.make(bounds.to)
          if (current === undefined) {
            diffCache.set(cacheKey, { seq, at: Date.now(), result: [] })
            return []
          }
          const diff = yield* snapshots.diff({ from: Snapshot.ID.make(bounds.from), to: current })
          if (diffCache.size > diffCacheLimit) {
            const oldest = diffCache.keys().next().value
            if (oldest !== undefined) diffCache.delete(oldest)
          }
          diffCache.set(cacheKey, { seq, at: Date.now(), result: diff })
          return diff
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.orElseSucceed(() => []),
        )
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* materializeBlobRefs(blob, yield* store.context(sessionID))
      }),
      events: (input) =>
        Stream.unwrap(
          result.get(input.sessionID).pipe(
            Effect.map(() => {
              // One cache per subscription: a replayed stream repeats the same
              // attachment across events, and each distinct blob is read once.
              const cache = new Map<string, string | undefined>()
              return events.durable({ aggregateID: input.sessionID, after: input.after }).pipe(
                Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event)),
                Stream.mapEffect((event) => materializeEvent(blob, cache, event)),
              )
            }),
          ),
        ),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        const page = yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
        // Same boundary as `events`: a replayed page carries the same payloads.
        return {
          ...page,
          events: yield* Effect.forEach(page.events, (event) => materializeEvent(blob, new Map(), event)),
        }
      }),
      inputs: Effect.fn("V2Session.inputs")(function* (input) {
        yield* result.get(input.sessionID)
        const page = yield* SessionInput.pending(db, input)
        const cache = new Map<string, string | undefined>()
        return {
          ...page,
          inputs: yield* Effect.forEach(page.inputs, (entry) =>
            materializePrompt(blob, cache, entry.prompt).pipe(Effect.map((prompt) => ({ ...entry, prompt }))),
          ),
        }
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            yield* requireMigrated(input.sessionID)
            // Image attachments arrive already shrunk: `session.prompt` in the
            // server owns that boundary, because the image limits come from
            // Location config and this service is not Location-scoped.
            const prompt = yield* SessionBlobStorage.externalizePromptAttachments(blob, resolvePrompt(input.prompt))
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* requireMigrated(session.id)
        const callID = input.id ?? SessionMessage.ID.create()
        const messageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Shell.Started, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          messageID,
          callID,
          command: input.command,
        })
        const output = yield* runShell(session, input.command)
        yield* events.publish(SessionEvent.Shell.Ended, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          callID,
          output,
        })
        if (input.resume !== false) yield* execution.wake(session.id)
      }),
      skill: Effect.fn("V2Session.skill")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* requireMigrated(session.id)
        const skill = yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          return (yield* skills.list()).find((item) => item.name === input.skill)
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.orElseSucceed(() => undefined),
        )
        if (skill === undefined) return yield* new NotFoundError({ sessionID: input.sessionID })
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: session.id,
          timestamp: yield* DateTime.now,
          messageID: SessionMessage.ID.create(),
          text: skill.content,
        })
        if (input.resume !== false) yield* execution.wake(session.id)
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* requireMigrated(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* requireMigrated(session.id)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        yield* requireMigrated(input.sessionID)
        SessionCompactRequest.request(input.sessionID)
        yield* execution.resume(input.sessionID).pipe(Effect.ignore)
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.wait(sessionID)
      }),
      active: execution.active,
      executions: execution.executions,
      interruptIf: (sessionID, identity) => Effect.uninterruptible(execution.interruptIf(sessionID, identity)),
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* requireMigrated(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    SessionCreate.node,
    AppProcess.node,
    LocationServiceMap.node,
    SessionProjector.node,
    Blob.node,
  ],
})
