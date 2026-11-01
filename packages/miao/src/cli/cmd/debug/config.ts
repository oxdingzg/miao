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
    yargs
      .option("sources", {
        type: "boolean",
        description: "Show each value's source file, scope and override order",
      })
      .option("engine", {
        type: "boolean",
        description: "Also print the normalized document the native engine reads, for comparison",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      if (args.engine) {
        // Two readers serve one document: this one, and the engine. Printing the
        // engine's answer for the same sources makes a divergence visible on a
        // real configuration instead of only in the fixture corpus.
        const plan = config.sources ? JSON.stringify(yield* config.sources()) : undefined
        if (!plan) return yield* fail("config sources are unavailable")
        const binary = process.env.MIAO_ENGINE_BIN ?? "miao-engine"
        const child = Bun.spawn([binary, "config", "json", "--config-sources", plan], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, code] = yield* Effect.promise(() =>
          Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
        )
        if (code !== 0) return yield* fail(`the engine refused the config: ${stderr.trim() || code}`)
        // The engine prints what it reads, secrets included; redact before it
        // reaches a terminal or a paste.
        process.stdout.write(JSON.stringify(redactConfig(JSON.parse(stdout)), null, 2) + EOL)
        return
      }
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
