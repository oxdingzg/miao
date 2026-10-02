import { Format } from "@miao/core/format"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const FormatterHandler = HttpApiBuilder.group(Api, "server.formatter", (handlers) =>
  handlers.handle(
    "formatter.status",
    Effect.fn(function* () {
      const format = yield* Format.Service
      return yield* response(format.status())
    }),
  ),
)
