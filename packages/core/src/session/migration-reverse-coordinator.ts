export * as SessionMigrationReverseCoordinator from "./migration-reverse-coordinator"

import { Effect, Schema } from "effect"
import { SessionID } from "@miao/schema/session-id"
import type { Model } from "@miao/schema/model"
import type { Provider } from "@miao/schema/provider"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { AbsolutePath } from "../schema"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionMessage } from "@miao/schema/session-message"
import { SessionMigration } from "./migration"
import { SessionMigrationReverse } from "./migration-reverse"

type Db = Database.Interface["db"]
type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>

export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()(
  "SessionMigrationReverseCoordinator.Unsupported",
  { sessionID: SessionID, reason: Schema.String },
) {}

/** The native Host's `transfer_export_delta` receipt: the native-era turns as
 * TS canonical messages with stable synthesized identities. */
export type DeltaReceipt = {
  id: string
  session_id: string
  /** Digest of the retained forward bundle (the reverse delta's baseline). */
  bundle_sha256: string
  /** Digest of the delta file itself; the coordinator verifies the exact bytes it reads. */
  delta_sha256: string
  baseline_seq: number
  timeline: unknown[]
}

/** Native source operations the reverse coordinator needs. */
export interface Engine {
  exportDelta(input: { importID: string; path: AbsolutePath }): Effect.Effect<DeltaReceipt, Error>
}

/** Move authority from the native engine back to the TypeScript catalog:
 * export the native-era delta, replay it onto the still-present catalog, flip
 * the placement, then complete. Every step is retryable and re-verifies
 * identity; a failure before the flip leaves the native source authoritative. */
export const toTypeScript = Effect.fn("SessionMigrationReverseCoordinator.toTypeScript")(function* (input: {
  database: Db
  id: string
  sessionID: SessionID
  native: Native
  bundleFile: AbsolutePath
  agent: string
  model: Model.Ref
  engine: Engine
}) {
  const conflict = () => new SessionMigrationReverse.Conflict({ sessionID: input.sessionID })
  let current = yield* SessionMigration.find(input.database, input.id)
  // A completed forward transfer keeps an audit row under the shared id; it is
  // finished work, so the reverse flow starts fresh and `prepare` turns that
  // row in place. An in-flight forward record is a real conflict.
  if (current && current.direction !== "rust_to_ts" && current.state !== "completed") return yield* conflict()
  if (current?.state === "completed") current = undefined
  if (!current) {
    const receipt = yield* input.engine.exportDelta({ importID: input.id, path: input.bundleFile })
    if (
      receipt.id !== input.id ||
      receipt.session_id !== input.sessionID ||
      !/^[a-f0-9]{64}$/.test(receipt.bundle_sha256) ||
      !/^[a-f0-9]{64}$/.test(receipt.delta_sha256) ||
      !Array.isArray(receipt.timeline)
    )
      return yield* conflict()
    const delta = yield* Effect.promise(() => Bun.file(input.bundleFile).text())
    if (Hash.sha256(delta) !== receipt.delta_sha256) return yield* conflict()
    current = yield* SessionMigrationReverse.prepare(input.database, {
      id: input.id,
      sessionID: input.sessionID,
      native: input.native,
      bundleSHA256: receipt.bundle_sha256,
      bundle: delta,
      sourceSeq: receipt.baseline_seq,
    })
  }
  if (!current.bundle) return yield* conflict()
  if (process.env.MIAO_CLI_DEBUG) console.error("[reverse] state:", current?.state, "dir:", current?.direction)
  if (current.state === "prepared") {
    if (process.env.MIAO_CLI_DEBUG) console.error("[reverse] importing delta")
    const raw = Schema.decodeUnknownSync(Schema.Struct({ timeline: Schema.Array(Schema.Unknown) }))(
      JSON.parse(current.bundle),
    )
    const parsed = {
      timeline: Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))(raw.timeline),
    }
    yield* SessionMigrationReverse.importDelta(input.database, {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      delta: { timeline: parsed.timeline as never[] },
    })
    if (process.env.MIAO_CLI_DEBUG) console.error("[reverse] delta imported")
    current = yield* SessionMigrationReverse.switchToTypeScript(input.database, {
      id: input.id,
      sessionID: input.sessionID,
      native: input.native,
      bundleSHA256: current.bundle_sha256,
    })
  }
  if (current.state === "switched") {
    current = yield* SessionMigrationReverse.complete(input.database, {
      id: input.id,
      sessionID: input.sessionID,
      native: input.native,
      bundleSHA256: current.bundle_sha256,
    })
  }
  return current
})
