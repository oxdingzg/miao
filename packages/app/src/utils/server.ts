import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  OpenCode,
  type CommandsListOutput,
  type IntegrationsGetOutput,
  type McpResourcesOutput,
  type McpStatusOutput,
  type MessagesListOutput,
  type PermissionsListRequestsOutput,
  type ProjectsListOutput,
  type SessionsGetOutput,
} from "@miao/client"
import type { Vcs } from "@miao/schema/vcs"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): ServerApi {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

export type ServerApi = ReturnType<typeof OpenCode.make>

// Named shapes the app passes around, derived from the generated `@miao/client` outputs.
export type SessionApi = ServerApi["sessions"]
export type AgentApi = ServerApi["agents"]
export type CommandApi = ServerApi["commands"]
export type ReferenceApi = ServerApi["references"]
export type CatalogApi = Pick<ServerApi, "providers" | "models">
export type SessionInfo = SessionsGetOutput
export type SessionMessageInfo = MessagesListOutput["data"][number]
export type SessionMessageUser = Extract<SessionMessageInfo, { type: "user" }>
export type SessionMessageShell = Extract<SessionMessageInfo, { type: "shell" }>
export type SessionMessageAssistant = Extract<SessionMessageInfo, { type: "assistant" }>
export type SessionMessageAssistantTool = Extract<SessionMessageAssistant["content"][number], { type: "tool" }>
export type FileDiffInfo = Vcs.Patch
export type McpStatus = McpStatusOutput["data"][string]
export type McpResource = McpResourcesOutput["data"][string]
export type CommandInfo = CommandsListOutput["data"][number]
export type Project = ProjectsListOutput["data"][number]
export type PermissionV2Request = PermissionsListRequestsOutput["data"][number]
export type IntegrationMethod = NonNullable<IntegrationsGetOutput["data"]>["methods"][number]
