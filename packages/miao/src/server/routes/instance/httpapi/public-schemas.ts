import { NonNegativeInt } from "@miao/core/schema"
import { ConfigV1 } from "@miao/core/v1/config/config"
import { Vcs } from "@miao/schema/vcs"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Command } from "@/command"
import { Workspace } from "@/control-plane/workspace"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"

// The V1 file-tree node shape the app renders; the app maps /api/fs/list onto it.
export const LegacyEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
}).annotate({ identifier: "FileNode" })

// The V1 file-content shape the app and session UI render; the app maps /api/fs/content onto it.
export const LegacyContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  diff: Schema.optional(Schema.String),
  patch: Schema.optional(
    Schema.Struct({
      oldFileName: Schema.String,
      newFileName: Schema.String,
      oldHeader: Schema.optional(Schema.String),
      newHeader: Schema.optional(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          oldStart: NonNegativeInt,
          oldLines: NonNegativeInt,
          newStart: NonNegativeInt,
          newLines: NonNegativeInt,
          lines: Schema.Array(Schema.String),
        }),
      ),
      index: Schema.optional(Schema.String),
    }),
  ),
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "FileContent" })

// V1-shaped types that clients still use as their own view models. No route returns them any
// more; listing them keeps them in the generated legacy SDK.
export const ClientSchemas = [
  Provider.Info,
  Provider.Model,
  ConfigV1.Info,
  Command.Info,
  Agent.Info,
  Auth.Info,
  ProviderAuth.Method,
  Vcs.FileDiff,
  Format.Status,
  Workspace.Info,
  MCP.Status,
  LSP.Status,
  LegacyEntry,
  LegacyContent,
]
