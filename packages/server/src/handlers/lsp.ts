import { LSP } from "@miao/core/lsp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const LspHandler = HttpApiBuilder.group(Api, "server.lsp", (handlers) =>
  handlers.handle(
    "lsp.status",
    Effect.fn(function* () {
      const lsp = yield* LSP.Service
      return yield* response(lsp.status())
    }),
  ),
)
