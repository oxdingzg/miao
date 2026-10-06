export * as Database from "./database"

import { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Schedule } from "effect"
import { DatabaseMigration } from "./migration"
import { DatabaseFile } from "./file"
import { makeGlobalNode } from "../effect/app-node"
import { RuntimeOwnership } from "../runtime/ownership"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly storage: string
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/storage/Database") {}

/** Owner opens migrate; a participant never migrates and must find a schema at least as new. */
const open = (options: { storage: string; migrate: boolean; usage?: RuntimeOwnership.Usage }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase

      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      if (options.usage) yield* DatabaseMigration.initialize(db, options.usage)
      else if (options.migrate) yield* DatabaseMigration.apply(db)
      else yield* DatabaseMigration.verify(db)

      return { db, storage: options.storage }
    }).pipe(Effect.orDie),
  )

export function layerFromPath(filename: string) {
  const ownership =
    filename === ":memory:"
      ? Layer.empty
      : Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.promise(() => RuntimeOwnership.acquireShared(filename)),
            (owner) => Effect.sync(owner.release),
          ),
        )
  // Ownership must build beneath the native layer, before opening or migrating.
  return open({ storage: filename, migrate: true }).pipe(
    Layer.provide(sqliteLayer({ filename }).pipe(Layer.provide(ownership))),
  )
}

/** Multiple windows may use a migrated database; migrations require exclusive access. */
export function sharedLayerFromPath(filename: string) {
  if (filename === ":memory:") return layerFromPath(filename)
  return Layer.unwrap(
    Effect.gen(function* () {
      const usage = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => RuntimeOwnership.use(filename), catch: (error) => error }).pipe(
          Effect.retry({
            while: (error) => error instanceof RuntimeOwnership.BusyError,
            schedule: Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100))),
          }),
          Effect.orDie,
        ),
        (owner) => Effect.sync(owner.release),
      )
      return open({ storage: usage.storage, migrate: true, usage }).pipe(
        Layer.provide(sqliteLayer({ filename: usage.storage })),
      )
    }),
  )
}

/**
 * Opens the same database as a participant rather than its owner: it never takes
 * the storage lock and never migrates, so a second process (an execution worker)
 * can commit durable events and projection rows while the owner keeps migrating.
 * A schema older than this build refuses to open, so a worker never writes
 * against columns it does not understand.
 */
export function participantLayerFromPath(filename: string) {
  return open({ storage: filename, migrate: false }).pipe(Layer.provide(sqliteLayer({ filename })))
}

export const path = DatabaseFile.path

/** Normal invocations share storage; explicit maintenance is exclusive. */
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() =>
    process.env.MIAO_DATABASE_EXCLUSIVE === "1" ? layerFromPath(path()) : sharedLayerFromPath(path()),
  ),
  deps: [],
})
