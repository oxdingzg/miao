import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite, retrySqliteBusy, sqliteReason } from "./sqlite"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@miao/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (
      query: string,
      params: ReadonlyArray<unknown> = [],
      attempt = 0,
    ): Effect.Effect<Array<Record<string, unknown>>, SqlError> =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
        } catch (cause) {
          const error = new SqlError({ reason: sqliteReason(cause, "execute") })
          return retrySqliteBusy(error, attempt, () => run(query, params, attempt + 1))
        }
      })

    const runValues = (
      query: string,
      params: ReadonlyArray<unknown> = [],
      attempt = 0,
    ): Effect.Effect<Array<unknown[]>, SqlError> =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
        } catch (cause) {
          const error = new SqlError({ reason: sqliteReason(cause, "execute") })
          return retrySqliteBusy(error, attempt, () => runValues(query, params, attempt + 1))
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        // Reserve the writer before any reads to avoid cross-window WAL snapshot upgrades.
        beginTransaction: "BEGIN IMMEDIATE",
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const WAL_BUSY_RETRY_DELAYS_MS = [100, 500, 2500]

/**
 * Enable WAL on a freshly opened connection. SQLite reports SQLITE_BUSY for
 * this pragma instead of honoring the busy handler when another window is
 * switching the same database, so retry a few times before giving up.
 */
const enableWAL = (native: Database) =>
  Effect.gen(function* () {
    yield* Effect.try({ try: () => native.run("PRAGMA busy_timeout = 5000;"), catch: (cause) => cause }).pipe(
      Effect.orDie,
    )
    for (const delay of [0, ...WAL_BUSY_RETRY_DELAYS_MS]) {
      if (delay > 0) yield* Effect.sleep(`${Math.round(delay * (0.8 + Math.random() * 0.4))} millis`)
      const result = yield* Effect.try({
        try: () => native.run("PRAGMA journal_mode = WAL;"),
        catch: (cause) => cause,
      }).pipe(Effect.exit)
      if (result._tag === "Success") return
      if (delay === WAL_BUSY_RETRY_DELAYS_MS[WAL_BUSY_RETRY_DELAYS_MS.length - 1])
        return yield* Effect.die(result.cause)
    }
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true) {
        // auto_vacuum must precede the first header write (WAL) to persist on a
        // new database. On an existing database it is a no-op until VACUUM, and
        // it is best-effort: a concurrent opener may hold the write lock.
        yield* Effect.try({
          try: () => native.run("PRAGMA auto_vacuum = INCREMENTAL;"),
          catch: () => undefined,
        }).pipe(Effect.ignore)
        // Switching a fresh database from the rollback journal to WAL needs
        // exclusive access, and SQLite can surface that as SQLITE_BUSY instead
        // of waiting when another window is opening the same file. Wait for the
        // lock and retry rather than failing the whole open.
        yield* enableWAL(native)
      }
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

/** A separate connection whose transaction holds the Runtime ownership lock. */
export function openRuntimeLock(filename: string) {
  const native = new Database(filename, { create: true, readwrite: true })
  return {
    exec: (sql: string) => {
      native.exec(sql)
    },
    close: () => native.close(),
  }
}
