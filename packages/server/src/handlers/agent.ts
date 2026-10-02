import { AgentV2 } from "@miao/core/agent"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { booted, response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers.handle("agent.list", () =>
    Effect.gen(function* () {
      yield* booted
      return yield* response(AgentV2.Service.use((agent) => agent.all()))
    }),
  ),
)
