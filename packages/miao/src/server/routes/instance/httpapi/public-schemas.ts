import { ConfigV1 } from "@miao/core/v1/config/config"
import { Vcs } from "@miao/schema/vcs"
import { FileContent, FileNode } from "@miao/schema/filesystem-v1"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Command } from "@/command"
import { Workspace } from "@/control-plane/workspace"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"

export { FileContent, FileNode }

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
  FileNode,
  FileContent,
]
