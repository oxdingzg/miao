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
import type {
  FileContent,
  PermissionV2Request as PermissionV2RequestVM,
  Provider,
  ProviderAuthMethod,
} from "@miao/schema/view-models"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "miao"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "miao",
    password: decoded.slice(separator + 1),
  }
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
// Same V2 record as the durable event wire; the list endpoint serves it verbatim.
// The list endpoint serves the same V2 record as the durable event wire, so
// app state uses the view-model type for both.
export type PermissionV2Request = PermissionV2RequestVM
export type IntegrationMethod = NonNullable<IntegrationsGetOutput["data"]>["methods"][number]

// Disconnecting a provider removes every credential stored for its integration.
export async function removeProviderCredentials(api: ServerApi, providerID: string) {
  const integration = await api.integrations.get({ integrationID: providerID })
  await Promise.all(
    (integration.data?.connections ?? []).flatMap((connection) =>
      connection.type === "credential" ? [api.credentials.remove({ credentialID: connection.id })] : [],
    ),
  )
}

// The file views render the V1 content shape: `encoding` is present only for base64, and the media type is `mimeType`.
export async function readFileContent(api: ServerApi, directory: string, path: string): Promise<FileContent> {
  const result = await api.files.content({ location: { directory }, path })
  return {
    type: result.data.type,
    content: result.data.content,
    ...(result.data.encoding === "base64" ? { encoding: "base64" as const } : {}),
    mimeType: result.data.mime,
  }
}

// V1 response shapes the app's stores still keep; no route returns them any more.
export type ProviderAuthResponse = Record<string, ProviderAuthMethod[]>
export type ProviderListResponse = { all: Provider[]; default: Record<string, string>; connected: string[] }
