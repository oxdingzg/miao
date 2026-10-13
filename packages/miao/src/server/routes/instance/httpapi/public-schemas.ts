import { ConfigV1 } from "@miao/core/v1/config/config"
import { Vcs } from "@miao/schema/vcs"
import { FileContent, FileNode } from "@miao/schema/filesystem-v1"
import { AgentView } from "@miao/schema/agent-view"
import { AuthView } from "@miao/schema/auth-view"
import { CommandView } from "@miao/schema/command-view"
import { FormatView } from "@miao/schema/format-view"
import { LspView } from "@miao/schema/lsp-view"
import { McpView } from "@miao/schema/mcp-view"
import { ProviderAuthView } from "@miao/schema/provider-auth-view"
import { ProviderView } from "@miao/schema/provider-view"
import { Workspace } from "./workspace-view"

export { FileContent, FileNode }

// V1-shaped types that clients still use as their own view models. No route returns them any
// more; listing them keeps them in the generated legacy SDK. They come from the schema view
// modules directly so the V1 service modules that used to re-export them stay deletable.
export const ClientSchemas = [
  ProviderView.Info,
  ProviderView.Model,
  ConfigV1.Info,
  CommandView.Info,
  AgentView.Info,
  AuthView.Info,
  ProviderAuthView.Method,
  Vcs.FileDiff,
  FormatView.Status,
  Workspace.Info,
  McpView.Status,
  LspView.Status,
  FileNode,
  FileContent,
]
