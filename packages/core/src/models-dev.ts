import path from "path"
import { Context, Duration, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@miao/schema/models-dev"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const InterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const USER_AGENT = `miao/${InstallationChannel}/${InstallationVersion}/${Flag.MIAO_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("toggle"),
  }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
])

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      InterleavedField,
      Schema.Struct({
        field: InterleavedField,
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = ModelsDev.Event

declare const MIAO_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ModelsDev") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.MIAO_MODELS_URL || "https://models.opencode.ai"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.hours(12)
    const lockKey = `models-dev:${filepath}`

    const diskMtime = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return undefined
      return Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
    })

    const fresh = Effect.fnUntraced(function* () {
      const mtime = yield* diskMtime()
      if (mtime === undefined) return false
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.MIAO_MODELS_PATH ?? filepath).pipe(
      Effect.catch((error) => {
        if (
          Flag.MIAO_MODELS_PATH === undefined &&
          error._tag === "FileSystemError" &&
          error.method === "readJson"
        ) {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof MIAO_MODELS_DEV === "undefined" ? undefined : MIAO_MODELS_DEV,
    )

    // A catalog snapshot can ship next to the executable (see script/build.ts).
    // It is the offline default when no user cache exists, and can be refreshed
    // independently of the compiled-in snapshot.
    const loadShipped = fs.readJson(path.join(path.dirname(process.execPath), "models.json")).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const shipped = yield* loadShipped
      if (shipped) return shipped as Record<string, Provider>
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.MIAO_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent opencode CLIs can race on this cache file.
      // A failed fetch must not take down provider listing; fall back to an empty
      // catalog and let the periodic background refresh retry later.
      return yield* Effect.gen(function* () {
        const text = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Flock.effect(lockKey)
            return yield* fetchAndWrite()
          }),
        )
        return JSON.parse(text) as Record<string, Provider>
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("unable to load models.dev catalog; continuing without it", { cause }).pipe(
            Effect.as({} as Record<string, Provider>),
          ),
        ),
      )
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    // mtime of the on-disk catalog the in-memory cache was loaded from. Lets a
    // running process notice when another process rewrites the cache file.
    const loadedMtime = yield* Ref.make<number | undefined>(undefined)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      populate.pipe(
        Effect.tap(() =>
          diskMtime().pipe(
            Effect.flatMap((mtime) => Ref.set(loadedMtime, mtime)),
            Effect.ignore,
          ),
        ),
      ),
      Duration.infinity,
    )

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    // Adopt a catalog another process wrote to disk. The disk file can still be
    // "fresh" (within the TTL) while its contents changed, so freshness alone
    // must not gate reloading — otherwise newly published models stay invisible
    // in long-running processes until restart.
    const adoptDiskChanges = Effect.fnUntraced(function* () {
      const mtime = yield* diskMtime()
      if (mtime === undefined) return
      if ((yield* Ref.get(loadedMtime)) === mtime) return
      yield* Ref.set(loadedMtime, mtime)
      yield* invalidate
      yield* events.publish(Event.Refreshed, {})
    })

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) {
        yield* adoptDiskChanges().pipe(Effect.ignore)
        return
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) {
            yield* adoptDiskChanges().pipe(Effect.ignore)
            return
          }
          yield* fetchAndWrite()
          yield* invalidate
          yield* diskMtime().pipe(
            Effect.flatMap((mtime) => Ref.set(loadedMtime, mtime)),
            Effect.ignore,
          )
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
        Effect.ignore,
      )
    })

    if (!Flag.MIAO_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Poll every minute. Network is still only hit when the on-disk cache is
      // stale; the rest of the time this just adopts changes written by other
      // processes so catalog updates don't require a restart.
      yield* Effect.forkScoped(
        refresh().pipe(Effect.repeat(Schedule.spaced("60 seconds")), Effect.ignore),
      )
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export * as ModelsDev from "./models-dev"
