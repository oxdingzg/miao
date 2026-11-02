import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { bootedCatalog, response } from "../location"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "provider.list",
      Effect.fn(function* () {
        const catalog = yield* bootedCatalog
        return yield* response(catalog.provider.available())
      }),
    )
  }),
)
