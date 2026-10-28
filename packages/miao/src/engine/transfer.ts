import { rename, writeFile } from "node:fs/promises"
import type { Location } from "@miao/schema/location"
import { SessionMessage } from "@miao/schema/session-message"
import { readTranscriptEntries } from "./transcript"
import { SessionMigrationCoordinator } from "@miao/core/session/migration-coordinator"
import { SessionMoveCoordinator } from "@miao/core/session/move-coordinator"
import { Effect, Schema } from "effect"

/** The subset of the engine control channel the coordinator needs. */
export interface Requester {
  request(method: string, params?: unknown): Promise<unknown>
}

const Receipt = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  bundle_sha256: Schema.String,
  state: Schema.String,
})

const call = <A>(
  client: Requester,
  method: string,
  params: unknown,
  decode: (value: unknown) => A,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => client.request(method, params),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.map(decode))

const decodeReceipt = Schema.decodeUnknownSync(Receipt)

const decodeMoveReceipt = SessionMoveCoordinator.decodeMoveReceipt

/** Maps the move coordinator's operations onto the engine Host commands.
 * The enriched export receipt carries the source binding triplet the native
 * staging call must replay. */
export function moveEngine(
  client: Requester,
  source?: { storage: string; location: Location.Ref },
): SessionMoveCoordinator.MoveEngine {
  return {
    exportMove: (input) =>
      call(
        client,
        "transfer_export_move",
        {
          session_id: input.sessionID,
          product_database: input.productDatabase,
          target_directory: input.targetDirectory,
          path: input.bundleFile,
        },
        decodeMoveReceipt,
      ).pipe(
        Effect.flatMap((receipt) =>
          source
            ? Effect.tryPromise({
                try: () => retainMoveDisplay(client, source, input, receipt),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              })
            : Effect.succeed(receipt),
        ),
      ),
    stageNative: (input) =>
      call(
        client,
        "transfer_stage_native",
        {
          import_id: input.importID,
          path: input.path,
          bundle_sha256: input.bundleSHA256,
          identity: input.identity,
          route_id: input.routeID,
          agent: input.agent,
        },
        decodeMoveReceipt,
      ),
    activate: (input) =>
      call(
        client,
        "transfer_activate",
        {
          import_id: input.importID,
          bundle_sha256: input.bundleSHA256,
          product_database: input.productDatabase,
        },
        decodeMoveReceipt,
      ),
  }
}

/** Maps the coordinator's native operations onto the engine Host commands. The
 * coordinator still verifies every receipt field; decoding here only rejects a
 * malformed frame before it can masquerade as a receipt. */
export function engine(client: Requester): SessionMigrationCoordinator.Engine {
  return {
    validate: (input) =>
      call(
        client,
        "transfer_validate",
        {
          path: input.path,
          bundle_sha256: input.bundleSHA256,
          identity: input.identity,
          route_id: input.routeID,
          agent: input.agent,
        },
        () => undefined,
      ),
    stage: (input) =>
      call(
        client,
        "transfer_stage",
        {
          import_id: input.importID,
          path: input.path,
          bundle_sha256: input.bundleSHA256,
          identity: input.identity,
          route_id: input.routeID,
          agent: input.agent,
        },
        decodeReceipt,
      ),
    activate: (input) =>
      call(
        client,
        "transfer_activate",
        {
          import_id: input.importID,
          bundle_sha256: input.bundleSHA256,
          product_database: input.productDatabase,
        },
        decodeReceipt,
      ),
  }
}

/** Native provider rows are execution history, not product rendering messages.
 * Retain the source journal projection beside those rows before the placement
 * fence. The destination can then page canonical IDs, tools and usage without
 * attempting to decode raw provider content as a product message. */
async function retainMoveDisplay(
  client: Requester,
  source: { storage: string; location: Location.Ref },
  input: Parameters<SessionMoveCoordinator.MoveEngine["exportMove"]>[0],
  receipt: SessionMoveCoordinator.MoveReceipt,
) {
  const bundle = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await Bun.file(input.bundleFile).text())
  const document = { ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(bundle) }
  const native = Schema.decodeUnknownSync(
    Schema.Struct({
      source: Schema.Struct({ sequence: Schema.Number }),
      timeline: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  )(document)
  const snapshot = await client.request("snapshot", { session_id: input.sessionID })
  const captured = Schema.decodeUnknownSync(
    Schema.Struct({
      cursor: Schema.Number,
      pending: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  )(snapshot)
  if (captured.pending?.length) throw new Error("Native Session has pending inputs; finish them before moving")
  if (captured.cursor !== native.source.sequence) throw new Error("Native Session changed during move export")
  const request = (method: string, params?: unknown) =>
    method === "snapshot" ? Promise.resolve(snapshot) : client.request(method, params)
  const [full, selected] = await Promise.all(
    [false, true].map((selected) =>
      readTranscriptEntries({
        sessionID: input.sessionID,
        engineID: source.storage,
        location: source.location,
        selected,
        request,
      }),
    ),
  )
  const rows = native.timeline.map((row) => ({ id: row.id, seq: Number(row.id.replace(/^msg_/, "")) }))
  if (rows.some((row) => !Number.isSafeInteger(row.seq) || row.seq < 0))
    throw new Error("Native move has an invalid source message sequence")
  document.display_timeline = Schema.encodeSync(Schema.Array(SessionMessage.Message))(
    full.map((entry) => entry.message),
  )
  document.display_context_ids = selected
    .filter((entry) => entry.message.metadata?.nativeCompaction === undefined)
    .map((entry) => entry.message.id)
  document.display_sources = Object.fromEntries(
    full.map((entry) => {
      const row = rows.findLast((row) => row.seq <= entry.seq) ?? rows[0]
      if (!row) throw new Error("Native move display has no source message")
      return [entry.message.id, row.id]
    }),
  )
  const encoded = JSON.stringify(document)
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new Error("Native move bundle size limit")
  const temporary = input.bundleFile + ".display.tmp"
  await writeFile(temporary, encoded, { mode: 0o600 })
  await rename(temporary, input.bundleFile)
  return { ...receipt, bundle_sha256: new Bun.CryptoHasher("sha256").update(encoded).digest("hex") }
}
