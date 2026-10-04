import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CapabilitiesHandler = HttpApiBuilder.group(Api, "server.capabilities", (handlers) =>
  handlers.handle(
    "capabilities.get",
    Effect.fn(function* () {
      return yield* response(Effect.succeed({ backgroundSubagents: false, pendingSessionInputs: true }))
    }),
  ),
)
