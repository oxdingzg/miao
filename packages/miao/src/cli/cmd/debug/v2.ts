import { EOL } from "os"
import { Deferred, Effect } from "effect"
import { Catalog } from "@miao/core/catalog"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { Location } from "@miao/core/location"
import { PluginV2 } from "@miao/core/plugin"
import { AbsolutePath } from "@miao/core/schema"
import { effectCmd } from "../../effect-cmd"

export const V2Command = effectCmd({
  command: "v2",
  describe: "debug v2 catalog and built-in plugins",
  instance: false,
  handler: () =>
    Effect.gen(function* () {
      // The catalog is what the location's plugin boot produces, so read it once
      // that boot is done: its output is otherwise empty or pre-filter.
      const plugins = yield* PluginV2.Service
      yield* Deferred.await(plugins.booted)
      const catalog = yield* Catalog.Service
      const providers = (yield* catalog.provider.available()).sort((a, b) => a.id.localeCompare(b.id))
      const all = (yield* catalog.provider.all()).sort((a, b) => a.id.localeCompare(b.id))
      const result = {
        providers,
        default: catalog.model.default().pipe(Effect.map((item) => item?.id)),
        small: Object.fromEntries(
          yield* Effect.all(
            all.map((provider) =>
              Effect.map(catalog.model.small(provider.id), (model) => [provider.id, model?.id] as const),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      }
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.v2"),
      Effect.provide(
        LocationServiceMap.Service.get(
          Location.Ref.make({
            directory: AbsolutePath.make(process.cwd()),
          }),
        ),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
