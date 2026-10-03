export * as ViewModels from "./view-models"

// Unbranded projections of the schema view models for clients that only render
// them. `StripBrand` removes Effect `Brand` from ids while keeping every field,
// optionality and readonly modifier, so these stay derived from the single
// @miao/schema source instead of a second hand-written surface.
import type { Brand } from "effect"
import { Agent as AgentV2 } from "./agent"
import { AgentView } from "./agent-view"
import { AuthView } from "./auth-view"
import { Command as CommandV2 } from "./command"
import { CommandView } from "./command-view"
import { Config as ConfigV2 } from "./config"
import { Connection } from "./connection"
import { Credential } from "./credential"
import { FileSystem } from "./filesystem"
import { FileSystemV1 } from "./filesystem-v1"
import { FormatView } from "./format-view"
import { Integration } from "./integration"
import { LLM } from "./llm"
import { Location } from "./location"
import { LspView } from "./lsp-view"
import { MCP } from "./mcp"
import { Model as ModelV2 } from "./model"
import { Permission } from "./permission"
import { PermissionSaved } from "./permission-saved"
import { Project as ProjectV2 } from "./project"
import { PromptInput as PromptInputV2 } from "./prompt-input"
import { Provider as ProviderV2 } from "./provider"
import { ProviderAuthView } from "./provider-auth-view"
import { ProviderView } from "./provider-view"
import { Question } from "./question"
import { Reference } from "./reference"
import { SessionInfo } from "./session-info"
import { SessionMessage as SessionMessageV2 } from "./session-message"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTodo } from "./session-todo"
import { SessionV1 } from "./session-v1"
import { Skill } from "./skill"
import { Vcs } from "./vcs"
import { Workspace as WorkspaceV2 } from "./workspace"

export type StripBrand<T> = T extends Brand.Brand<infer _>
  ? T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T
  : T extends ReadonlyArray<infer U>
    ? Array<StripBrand<U>>
    : T extends object
      ? { -readonly [K in keyof T]: StripBrand<T[K]> }
      : T

// Session V1 view models.
export type Message = StripBrand<SessionV1.Message>
export type UserMessage = StripBrand<SessionV1.User>
export type AssistantMessage = StripBrand<SessionV1.Assistant>
export type Session = StripBrand<SessionV1.SessionInfo>
export type Part = StripBrand<SessionV1.Part>
export type ToolPart = StripBrand<SessionV1.ToolPart>
export type TextPart = StripBrand<SessionV1.TextPart>
export type ReasoningPart = StripBrand<SessionV1.ReasoningPart>
export type FilePart = StripBrand<SessionV1.FilePart>
export type AgentPart = StripBrand<SessionV1.AgentPart>
export type FilePartSource = StripBrand<SessionV1.FilePartSource>
export type ToolState = StripBrand<SessionV1.ToolState>

// Files and VCS.
export type FileNode = StripBrand<FileSystemV1.FileNode>
export type FileContent = StripBrand<FileSystemV1.FileContent>
export type SnapshotFileDiff = StripBrand<Vcs.SnapshotFileDiff>
export type VcsFileDiff = StripBrand<Vcs.FileDiff>
export type VcsFileStatus = StripBrand<Vcs.FileStatus>
export type VcsInfo = StripBrand<Vcs.Info>

// Provider / model / agent / command / auth.
export type Provider = StripBrand<ProviderView.Provider>
export type Model = StripBrand<ProviderView.Model>
export type AgentV2Info = StripBrand<AgentV2.Info>
export type Agent = StripBrand<AgentView.Agent>
export type CommandV2Info = StripBrand<CommandV2.Info>
export type Command = StripBrand<CommandView.Command>
export type Auth = StripBrand<AuthView.Auth>
export type ProviderAuthMethod = StripBrand<ProviderAuthView.ProviderAuthMethod>
export type Config = StripBrand<ConfigV2.Info>

// Sessions V2 / messages / status.
export type SessionV2Info = StripBrand<SessionInfo.Info>
export type SessionMessage = StripBrand<SessionMessageV2.Message>
export type SessionMessageAssistant = StripBrand<SessionMessageV2.Assistant>
export type SessionMessageAssistantText = StripBrand<SessionMessageV2.AssistantText>
export type SessionMessageAssistantTool = StripBrand<SessionMessageV2.AssistantTool>
export type SessionMessageAssistantReasoning = StripBrand<SessionMessageV2.AssistantReasoning>
export type SessionStatus = StripBrand<SessionStatusEvent.SessionStatus>
export type Todo = StripBrand<SessionTodo.Todo>

// Question / permission.
export type QuestionRequest = StripBrand<Question.Request>
export type QuestionInfo = StripBrand<Question.Info>
export type QuestionAnswer = StripBrand<Question.Answer>
export type QuestionV2Request = StripBrand<Question.Request>
export type QuestionV2Answer = StripBrand<Question.Answer>
export type PermissionRequest = StripBrand<Permission.Request>
export type PermissionV2Request = StripBrand<Permission.Request>
export type PermissionSavedInfo = StripBrand<PermissionSaved.Info>

// Integration / credential / reference / skill / llm / prompt.
export type IntegrationInfo = StripBrand<Integration.Info>
export type IntegrationAttempt = StripBrand<Integration.Attempt>
export type IntegrationRef = StripBrand<Integration.Ref>
export type IntegrationInputs = StripBrand<Integration.Inputs>
export type IntegrationMethod = StripBrand<Integration.Method>
export type IntegrationEnvMethod = StripBrand<Integration.EnvMethod>
export type IntegrationKeyMethod = StripBrand<Integration.KeyMethod>
export type IntegrationOAuthMethod = StripBrand<Integration.OAuthMethod>
export type ConnectionInfo = StripBrand<Connection.Info>
export type CredentialValue = StripBrand<Credential.Value>
export type CredentialOAuth = StripBrand<Credential.OAuth>
export type ReferenceInfo = StripBrand<Reference.Info>
export type ReferenceGitSource = StripBrand<Reference.GitSource>
export type ReferenceLocalSource = StripBrand<Reference.LocalSource>
export type FileSystemEntry = StripBrand<FileSystem.Entry>
export type SkillV2Info = StripBrand<Skill.Info>
export type SkillV2Source = StripBrand<Skill.Source>
export type LlmToolContent = StripBrand<LLM.ToolContent>
export type PromptInput = StripBrand<PromptInputV2.Prompt>

// Location / workspace / project / mcp / diagnostics.
export type LocationRef = StripBrand<Location.Ref>
export type LocationInfo = StripBrand<Location.Info>
export type Workspace = StripBrand<WorkspaceV2.Info>
export type WorkspaceAdapterEntry = StripBrand<WorkspaceV2.AdapterEntry>
export type Project = StripBrand<ProjectV2.Info>
export type McpStatus = StripBrand<MCP.Status>
export type McpServerStatus = StripBrand<MCP.Status>
export type McpResource = StripBrand<MCP.Resource>
export type FormatterStatus = StripBrand<FormatView.FormatterStatus>
export type LspStatus = StripBrand<LspView.LspStatus>
