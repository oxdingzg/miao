import { SessionMigrationCoordinator } from "@miao/core/session/migration-coordinator"
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
