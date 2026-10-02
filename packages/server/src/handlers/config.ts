import { Config } from "@miao/core/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers.handle(
    "config.get",
    Effect.fn(function* () {
      const config = yield* Config.Service
      const entries = yield* config.entries()
      return yield* response(Effect.succeed(Config.merge(entries)))
    }),
  ),
)
