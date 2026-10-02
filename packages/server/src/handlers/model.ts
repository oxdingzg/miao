import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { bootedCatalog, response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          const catalog = yield* bootedCatalog
          return yield* response(catalog.model.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const catalog = yield* bootedCatalog
          return yield* response(catalog.model.default().pipe(Effect.map((model) => model ?? null)))
        }),
      )
  }),
)
