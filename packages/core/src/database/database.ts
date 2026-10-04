export * as Database from "./database"

import { EffectDrizzleSqlite } from "@miao/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { DatabaseMigration } from "./migration"
import { DatabaseFile } from "./file"
import { makeGlobalNode } from "../effect/app-node"
import { RuntimeOwnership } from "../runtime/ownership"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
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
  return layer.pipe(Layer.provide(sqliteLayer({ filename }).pipe(Layer.provide(ownership))))
}

export const path = DatabaseFile.path

export const node = makeGlobalNode({ service: Service, layer: Layer.suspend(() => layerFromPath(path())), deps: [] })
