export * as SessionStore from "./store"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionV1 } from "../v1/session"
import { SessionV1Read } from "./v1-read"
import { fromRow } from "./info"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    const loadV1 = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const messageRows = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .all()
        .pipe(Effect.orDie)
      if (messageRows.length === 0) return undefined
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.session_id, sessionID))
        .orderBy(asc(PartTable.time_created), asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
      const byMessage = new Map<string, SessionV1.Part[]>()
      for (const row of partRows) {
        const list = byMessage.get(row.message_id) ?? []
        list.push({ ...(row.data as object), id: row.id, sessionID, messageID: row.message_id } as SessionV1.Part)
        byMessage.set(row.message_id, list)
      }
      return messageRows.map((row) => ({
        info: { ...(row.data as object), id: row.id, sessionID } as SessionV1.Info,
        parts: byMessage.get(row.id) ?? [],
      }))
    })

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        const projected = yield* SessionHistory.load(db, sessionID)
        if (projected.length > 0) return projected
        const legacy = yield* loadV1(sessionID)
        return legacy === undefined ? projected : SessionV1Read.map(legacy)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
