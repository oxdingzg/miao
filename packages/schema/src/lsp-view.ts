export * as LspView from "./lsp-view"

import { Schema } from "effect"

// The V1 LSP status view model projected to clients.
export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

export const LspStatus = Status
export type LspStatus = Status
