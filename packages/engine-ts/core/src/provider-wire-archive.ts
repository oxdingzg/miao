export * as ProviderWireArchiveStore from "./provider-wire-archive"

import path from "path"
import { Duration, Effect, FileSystem, Layer, Option, Ref, Semaphore } from "effect"
import { ProviderWireArchive } from "@miao/llm/route"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { runID } from "./observability/shared"

/**
 * The host half of the provider wire archive: NDJSON, one file per process,
 * rotated by size and pruned by age.
 *
 * Off unless `MIAO_LLM_WIRE_ARCHIVE` names a destination, and off means absent
 * rather than inert — the layer produces no service, so the client and executor
 * skip tracing entirely instead of building lines for a sink that discards
 * them. Recording is forensic, so the sink must never affect the request it is
 * observing: every write failure is logged and dropped.
 */

export const MANAGED_DIRECTORY = "provider-wire"
export const MAX_FILE_BYTES = 32 * 1024 * 1024
export const RETENTION = Duration.days(2)

const PREFIX = "wire_"

/** `1`/`true` records into the log directory; any other value is the directory itself. */
export const directoryFor = (value: string, log: string) =>
  value === "1" || value.toLowerCase() === "true" ? path.join(log, MANAGED_DIRECTORY) : path.resolve(value)

/**
 * Empty when unarmed, which is why this is typed as producing nothing: a `Layer`
 * is contravariant in what it produces, so "sometimes this service, sometimes
 * none" is expressed as `never`. Consumers reach it through `serviceOption`, so
 * absence is a value they can see, not a hole they can fall into.
 */
export const layer: Layer.Layer<never, never, FileSystem.FileSystem | Global.Service> = Layer.unwrap(
  Effect.gen(function* () {
    const value = Flag.MIAO_LLM_WIRE_ARCHIVE
    if (value === undefined || value.trim() === "") return Layer.empty
    const global = yield* Global.Service
    return sink(directoryFor(value.trim(), global.log))
  }),
)

const sink = (
  directory: string,
): Layer.Layer<ProviderWireArchive.Service, never, FileSystem.FileSystem | Global.Service> =>
  Layer.effect(
    ProviderWireArchive.Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const gate = yield* Semaphore.make(1)
      const current = yield* Ref.make({ index: 1, bytes: 0 })
      const file = (index: number) => path.join(directory, `${PREFIX}${runID}_${index}.ndjson`)

      const prune = Effect.fn("ProviderWireArchive.prune")(function* () {
        const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([] as string[])))
        const cutoff = Date.now() - Duration.toMillis(RETENTION)
        for (const entry of entries) {
          if (!entry.startsWith(PREFIX)) continue
          const target = path.join(directory, entry)
          const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const modified = info === undefined ? undefined : info.mtime.pipe(Option.getOrUndefined)?.getTime()
          if (modified !== undefined && modified < cutoff)
            yield* fs.remove(target).pipe(Effect.catch(() => Effect.void))
        }
      })

      const record: ProviderWireArchive.Interface["record"] = (line) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const text = `${JSON.stringify(line)}\n`
            const previous = yield* Ref.get(current)
            const rotated = previous.bytes > 0 && previous.bytes + Buffer.byteLength(text) > MAX_FILE_BYTES
            const index = rotated ? previous.index + 1 : previous.index
            yield* fs.writeFileString(file(index), text, { flag: "a" })
            yield* Ref.set(current, {
              index,
              bytes: rotated ? Buffer.byteLength(text) : previous.bytes + Buffer.byteLength(text),
            })
            if (rotated) yield* prune()
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("provider-wire.write-failed", { directory, cause: String(error) }),
            ),
          ),
        )

      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.catch(() => Effect.void))
      yield* prune().pipe(Effect.catch(() => Effect.void))

      return ProviderWireArchive.Service.of({ record })
    }),
  )
