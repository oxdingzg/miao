import { EOL } from "os"
import { Effect } from "effect"
import { Config } from "@miao/core/config"
import type { ConfigExplain } from "@miao/core/config/explain"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { effectCmd, fail } from "../../effect-cmd"
import { redactConfig } from "./redact"

/** Rebuilds one leaf as nested objects so redaction sees the key names on its path. */
const nest = (path: readonly string[], value: unknown): Record<string, unknown> =>
  path.length === 1 ? { [path[0]!]: value } : { [path[0]!]: nest(path.slice(1), value) }

const read = (value: Record<string, unknown>, path: readonly string[]): unknown =>
  path.length === 1 ? value[path[0]!] : read(value[path[0]!] as Record<string, unknown>, path.slice(1))

const redactLeaf = (path: readonly string[], value: unknown) =>
  read(redactConfig(nest(path, value)) as Record<string, unknown>, path)

/** Applies the debug redaction rules to an explanation, keeping its provenance intact. */
export const redactExplanation = (explanation: ConfigExplain.Explanation): ConfigExplain.Explanation => ({
  sources: explanation.sources,
  keys: explanation.keys.map((key) => ({
    ...key,
    value: redactLeaf(key.path, key.value),
    overridden: key.overridden.map((leaf) => ({ ...leaf, value: redactLeaf(key.path, leaf.value) })),
  })),
})

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) =>
    yargs.option("sources", {
      type: "boolean",
      description: "Show each value's source file, scope and override order",
    }),
  handler: (args) =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      if (!args.sources) {
        process.stdout.write(JSON.stringify(redactConfig(Config.merge(entries)), null, 2) + EOL)
        return
      }
      // Only the real layer knows the scope of each document; a test double
      // that omits `explain` cannot answer this question.
      if (!config.explain) return yield* fail("config sources are unavailable")
      const explanation = yield* config.explain()
      process.stdout.write(JSON.stringify(redactExplanation(explanation), null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.config"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
