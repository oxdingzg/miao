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
      .option("all", {
        describe: "list the whole catalog, marking models this channel cannot use",
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
      // The default listing is what this channel can actually run: a provider
      // appears once it has a credential or an integration connection. Listing
      // the whole catalog by default offered ids like `opencode/*` that the TUI
      // and `miao run` both reject.
      const available = yield* catalog.model.available()
      const usable = new Set(available.map((model) => `${model.providerID}/${model.id}`))
      const listed = args.all ? models : available
      const grouped = Map.groupBy(listed, (model) => model.providerID)
      const providers = Map.groupBy(models, (model) => model.providerID)

      const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
        const sorted = (grouped.get(providerID) ?? []).sort((a, b) => a.id.localeCompare(b.id))
        for (const model of sorted) {
          process.stdout.write(`${providerID}/${model.id}`)
          if (!usable.has(`${providerID}/${model.id}`)) process.stdout.write(" (unavailable)")
          process.stdout.write(EOL)
          if (verbose) {
            process.stdout.write(JSON.stringify(model, null, 2))
            process.stdout.write(EOL)
          }
        }
      }

      if (args.provider) {
        const providerID = ProviderV2.ID.make(args.provider)
        if (!providers.has(providerID)) return yield* fail(`Provider not found: ${args.provider}`)
        if (!grouped.has(providerID))
          return yield* fail(
            `Provider ${args.provider} is not available here; run \`miao models --all ${args.provider}\` to list its catalog models`,
          )
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
