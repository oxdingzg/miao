import { EOL } from "os"
import { Deferred, Effect } from "effect"
import { Catalog } from "@miao/core/catalog"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { ModelsCatalog } from "@miao/core/models-catalog"
import { PluginV2 } from "@miao/core/plugin"
import { ProviderV2 } from "@miao/core/provider"
import { AbsolutePath } from "@miao/core/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from the catalog",
        type: "boolean",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      if (args.refresh) {
        yield* ModelsCatalog.Service.use((s) => s.refresh(true))
        UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
      }

      const catalog = yield* Catalog.Service
      // The catalog is what the location's plugin boot produces; without the
      // boot barrier the model list is empty (same as `debug v2`).
      yield* Deferred.await((yield* PluginV2.Service).booted)
      const models = yield* catalog.model.all()
      const grouped = Map.groupBy(models, (model) => model.providerID)

      const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
        const sorted = (grouped.get(providerID) ?? []).sort((a, b) => a.id.localeCompare(b.id))
        for (const model of sorted) {
          process.stdout.write(`${providerID}/${model.id}`)
          process.stdout.write(EOL)
          if (verbose) {
            process.stdout.write(JSON.stringify(model, null, 2))
            process.stdout.write(EOL)
          }
        }
      }

      if (args.provider) {
        const providerID = ProviderV2.ID.make(args.provider)
        if (!grouped.has(providerID)) return yield* fail(`Provider not found: ${args.provider}`)
        print(providerID, args.verbose)
        return
      }

      const ids = [...grouped.keys()].sort((a, b) => {
        const aIsOpencode = a.startsWith("opencode")
        const bIsOpencode = b.startsWith("opencode")
        if (aIsOpencode && !bIsOpencode) return -1
        if (!aIsOpencode && bIsOpencode) return 1
        return a.localeCompare(b)
      })

      for (const providerID of ids) print(providerID, args.verbose)
    }).pipe(
      Effect.withSpan("Cli.models"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
