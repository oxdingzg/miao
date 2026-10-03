import { Config } from "@miao/core/config"
import { ConfigWrite } from "@miao/core/config/write"
import { EventV2 } from "@miao/core/event"
import { LocationServiceMap } from "@miao/core/location-service-map"
import { InvalidRequestError } from "@miao/protocol/errors"
import { ConfigEvent } from "@miao/schema/config-event"
import { Effect, RcMap } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { bootedCatalog, response } from "../location"
import { defaultModelIDs, projectProviders } from "./provider-projection"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  Effect.gen(function* () {
    const write = yield* ConfigWrite.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    return handlers
      .handle(
        "config.update",
        Effect.fn(function* (ctx) {
          const result = yield* write
            .updateGlobal(ctx.payload.config)
            .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "Payload" })))
          if (result.changed) {
            // Open locations keep the config they read at boot. Drop them so the next request rebuilds them;
            // a drain that still holds one finishes on the config it started with.
            yield* Effect.forEach(yield* RcMap.keys(locations.rcMap), (ref) => locations.invalidate(ref), {
              discard: true,
            })
            yield* events.publish(ConfigEvent.Updated, {})
          }
          return yield* response(Effect.succeed(result.document))
        }),
      )
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
      )
  }),
)
