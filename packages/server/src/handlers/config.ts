import { Config } from "@miao/core/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { bootedCatalog, response } from "../location"
import { defaultModelIDs, projectProviders } from "./provider-projection"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle(
      "config.get",
      Effect.fn(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()
        return yield* response(Effect.succeed(Config.merge(entries)))
      }),
    )
    .handle(
      "config.providers",
      Effect.fn(function* () {
        const catalog = yield* bootedCatalog
        const providers = yield* catalog.provider.available()
        const models = yield* catalog.model.available()
        const fallback = yield* catalog.model.default()
        return yield* response(
          Effect.succeed({
            providers: projectProviders(providers, models),
            default: defaultModelIDs(providers, models, fallback),
          }),
        )
      }),
    )
    .handle(
      "config.catalog",
      Effect.fn(function* () {
        const catalog = yield* bootedCatalog
        const providers = yield* catalog.provider.all()
        const models = yield* catalog.model.all()
        const available = yield* catalog.provider.available()
        const fallback = yield* catalog.model.default()
        return yield* response(
          Effect.succeed({
            all: projectProviders(providers, models),
            default: defaultModelIDs(providers, models, fallback),
            connected: available.map((provider) => provider.id),
          }),
        )
      }),
    ),
)
