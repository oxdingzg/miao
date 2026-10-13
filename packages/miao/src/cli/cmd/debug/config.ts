import { EOL } from "os"
import { Effect } from "effect"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { effectCmd } from "../../effect-cmd"
import { redactConfig } from "./redact"

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  handler: () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      process.stdout.write(JSON.stringify(redactConfig(Config.merge(entries)), null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.config"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
