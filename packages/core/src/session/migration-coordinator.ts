export * as SessionMigrationCoordinator from "./migration-coordinator"

import { SessionID } from "@miao/schema/session-id"
import { Effect } from "effect"
import { Database } from "../database/database"
import { AbsolutePath } from "../schema"
import { SessionEnginePlacement } from "./engine-placement"
import { SessionMigration } from "./migration"
import { SessionTransferBundle } from "./transfer-bundle"

type Db = Database.Interface["db"]
type Native = Extract<SessionEnginePlacement.Placement, { engine: "rust" }>

/** A receipt is a native Host statement about one exact import; the coordinator
 * verifies every field before advancing durable product state. */
export type Receipt = {
  id: string
  session_id: string
  bundle_sha256: string
  state: string
}

export type Identity = { protocol: string; model: string }

/** Native Host operations, implemented by the engine adapter. The coordinator
 * owns ordering and durable recovery; it never assumes an operation succeeded. */
export interface Engine {
  validate(input: {
    path: AbsolutePath
    bundleSHA256: string
    identity: Identity
    routeID?: string
    agent?: Record<string, unknown>
  }): Effect.Effect<void, Error>
  stage(input: {
    importID: string
    path: AbsolutePath
    bundleSHA256: string
    identity: Identity
    routeID?: string
    agent?: Record<string, unknown>
  }): Effect.Effect<Receipt, Error>
  activate(input: {
    importID: string
    bundleSHA256: string
    productDatabase: AbsolutePath
  }): Effect.Effect<Receipt, Error>
}

export const toNative = Effect.fn("SessionMigrationCoordinator.toNative")(function* (input: {
  database: Db
  id: string
  sessionID: SessionID
  target: Native
  bundleFile: AbsolutePath
  productDatabase: AbsolutePath
  identity: Identity
  routeID?: string
  agent?: Record<string, unknown>
  engine: Engine
}) {
  const fail = () => Effect.fail(new SessionMigration.Conflict({ sessionID: input.sessionID }))
  let current = yield* SessionMigration.find(input.database, input.id)
  if (current && !["frozen", "prepared", "switched", "completed"].includes(current.state)) return yield* fail()
  if (!current) {
    const captured = yield* SessionTransferBundle.prepare({
      id: input.id,
      sessionID: input.sessionID,
      target: input.target,
      validate: ({ serialized, digest }) =>
        Effect.gen(function* () {
          // The native Host reads a private immutable file instead of receiving
          // up to 64 MiB through its control channel. Rewriting the same bytes
          // on resume keeps the digest check meaningful.
          yield* Effect.promise(() => Bun.write(input.bundleFile, serialized))
          yield* input.engine.validate({
            path: input.bundleFile,
            bundleSHA256: digest,
            identity: input.identity,
            routeID: input.routeID,
            agent: input.agent,
          })
        }),
    })
    current = yield* SessionMigration.find(input.database, input.id)
    if (!current || current.state !== "frozen" || current.bundle_sha256 !== captured.digest) return yield* fail()
  }
  if (!current.bundle_sha256) return yield* fail()
  const identity = {
    id: input.id,
    sessionID: input.sessionID,
    target: input.target,
    bundleSHA256: current.bundle_sha256,
  }
  if (current.state === "frozen") {
    // A failed stage leaves the source frozen only if we crash; otherwise the
    // durable freeze is released so the user keeps an editable source.
    const receipt = yield* input.engine
      .stage({
        importID: input.id,
        path: input.bundleFile,
        bundleSHA256: identity.bundleSHA256,
        identity: input.identity,
        routeID: input.routeID,
        agent: input.agent,
      })
      .pipe(
        Effect.flatMap((receipt) =>
          receipt.id === input.id &&
          receipt.session_id === input.sessionID &&
          receipt.bundle_sha256 === identity.bundleSHA256 &&
          receipt.state === "staged"
            ? Effect.succeed(receipt)
            : fail(),
        ),
        Effect.catch((error) =>
          SessionMigration.abort(input.database, identity).pipe(Effect.andThen(Effect.fail(error))),
        ),
      )
    current = yield* SessionMigration.prepared(input.database, {
      ...identity,
      receipt: { ...receipt, state: "staged" },
    })
  }
  if (current.state === "prepared") current = yield* SessionMigration.switchToNative(input.database, identity)
  if (current.state === "switched") {
    // Activated state is deliberately not aborted on failure: the product
    // placement already points here, so recovery must finish this exact copy.
    const receipt = yield* input.engine.activate({
      importID: input.id,
      bundleSHA256: identity.bundleSHA256,
      productDatabase: input.productDatabase,
    })
    if (
      receipt.id !== input.id ||
      receipt.session_id !== input.sessionID ||
      receipt.bundle_sha256 !== identity.bundleSHA256
    )
      return yield* fail()
    if (receipt.state !== "active") return yield* fail()
    current = yield* SessionMigration.complete(input.database, {
      ...identity,
      receipt: { ...receipt, state: "active" },
    })
  }
  return current
})
