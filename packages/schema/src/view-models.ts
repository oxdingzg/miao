export * as ViewModels from "./view-models"

// Unbranded, wire-shaped projections of the schema view models for clients that
// only render them. `StripBrand` removes Effect `Brand`; `Schema.Encoded` takes
// the encoded (wire) form so transformed fields such as `DateTimeUtcFromMillis`
// stay numbers, matching the generated SDK. Both stay derived from the single
// @miao/schema source instead of a second hand-written surface.
import type { Brand } from "effect"
import { Schema } from "effect"
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
import { PermissionV1 } from "./permission-v1"
import { Project as ProjectV2 } from "./project"
import { PromptInput as PromptInputV2 } from "./prompt-input"
import { Provider as ProviderV2 } from "./provider"
import { ProviderAuthView } from "./provider-auth-view"
import { ProviderView } from "./provider-view"
import { Question } from "./question"
import { QuestionV1 } from "./question-v1"
import { Reference } from "./reference"
import { SessionInfo } from "./session-info"
import { SessionMessage as SessionMessageV2 } from "./session-message"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTodo } from "./session-todo"
import { SessionV1 } from "./session-v1"
import { Skill } from "./skill"
import { Vcs } from "./vcs"
import { Workspace as WorkspaceV2 } from "./workspace"

export type StripBrand<T> = unknown extends T
  ? T
  : Schema.Json extends T
    ? Schema.Json | Extract<T, undefined>
    : T extends Brand.Brand<infer _>
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

type Wire<S> = StripBrand<Schema.Codec.Encoded<S>>

// Session view model: the V2 record is the wire truth; messages stay on the V1
// wire until the transcript cutover lands.
export type Session = Wire<typeof SessionInfo.Info>
export type Message = Wire<typeof SessionV1.Info>
export type UserMessage = Wire<typeof SessionV1.User>
export type AssistantMessage = Wire<typeof SessionV1.Assistant>
export type Part = Wire<typeof SessionV1.Part>
export type ToolPart = Wire<typeof SessionV1.ToolPart>
export type TextPart = Wire<typeof SessionV1.TextPart>
export type ReasoningPart = Wire<typeof SessionV1.ReasoningPart>
export type FilePart = Wire<typeof SessionV1.FilePart>
export type AgentPart = Wire<typeof SessionV1.AgentPart>
export type FilePartSource = Wire<typeof SessionV1.FilePartSource>
export type ToolState = Wire<typeof SessionV1.ToolState>

// Files and VCS.
export type FileNode = Wire<typeof FileSystemV1.FileNode>
export type FileContent = Wire<typeof FileSystemV1.FileContent>
export type SnapshotFileDiff = Wire<typeof Vcs.SnapshotFileDiff>
export type VcsFileDiff = Wire<typeof Vcs.FileDiff>
export type VcsFileStatus = Wire<typeof Vcs.FileStatus>
export type VcsInfo = Wire<typeof Vcs.Info>

// Provider / model / agent / command / auth.
export type Provider = Wire<typeof ProviderView.Info>
export type Model = Wire<typeof ProviderView.Model>
export type ProviderV2Info = Wire<typeof ProviderV2.Info>
export type ModelV2Info = Wire<typeof ModelV2.Info>
export type AgentV2Info = Wire<typeof AgentV2.Info>
export type Agent = Wire<typeof AgentView.Agent>
export type CommandV2Info = Wire<typeof CommandV2.Info>
export type Command = Wire<typeof CommandView.Command>
export type Auth = Wire<typeof AuthView.Auth>
export type ProviderAuthMethod = Wire<typeof ProviderAuthView.ProviderAuthMethod>
export type Config = Wire<typeof ConfigV2.Info>

// Sessions V2 / messages / status.
export type SessionV2Info = Wire<typeof SessionInfo.Info>
export type SessionMessage = Wire<typeof SessionMessageV2.Message>
export type SessionMessageAssistant = Wire<typeof SessionMessageV2.Assistant>
export type SessionMessageAssistantText = Wire<typeof SessionMessageV2.AssistantText>
export type SessionMessageAssistantTool = Wire<typeof SessionMessageV2.AssistantTool>
export type SessionMessageAssistantReasoning = Wire<typeof SessionMessageV2.AssistantReasoning>
export type SessionStatus = Wire<typeof SessionStatusEvent.Info>
export type Todo = Wire<typeof SessionTodo.Info>

// Question / permission.
export type QuestionRequest = Wire<typeof QuestionV1.Request>
export type QuestionInfo = Wire<typeof Question.Info>
export type QuestionAnswer = Wire<typeof Question.Answer>
export type QuestionV2Request = Wire<typeof Question.Request>
export type QuestionV2Answer = Wire<typeof Question.Answer>
export type PermissionRequest = Wire<typeof PermissionV1.Request>
export type PermissionV2Request = Wire<typeof Permission.Request>
export type PermissionSavedInfo = Wire<typeof PermissionSaved.Info>

// Integration / credential / reference / skill / llm / prompt.
export type IntegrationInfo = Wire<typeof Integration.Info>
export type IntegrationAttempt = Wire<typeof Integration.Attempt>
export type IntegrationRef = Wire<typeof Integration.Ref>
export type IntegrationInputs = Wire<typeof Integration.Inputs>
export type IntegrationMethod = Wire<typeof Integration.Method>
export type IntegrationEnvMethod = Wire<typeof Integration.EnvMethod>
export type IntegrationKeyMethod = Wire<typeof Integration.KeyMethod>
export type IntegrationOAuthMethod = Wire<typeof Integration.OAuthMethod>
export type ConnectionInfo = Wire<typeof Connection.Info>
export type CredentialValue = Wire<typeof Credential.Value>
export type CredentialOAuth = Wire<typeof Credential.OAuth>
export type ReferenceInfo = Wire<typeof Reference.Info>
export type ReferenceGitSource = Wire<typeof Reference.GitSource>
export type ReferenceLocalSource = Wire<typeof Reference.LocalSource>
export type FileSystemEntry = Wire<typeof FileSystem.Entry>
export type SkillV2Info = Wire<typeof Skill.Info>
export type SkillV2Source = Wire<typeof Skill.Source>
export type LlmToolContent = Wire<typeof LLM.ToolContent>
export type PromptInput = Wire<typeof PromptInputV2.Prompt>

// Location / workspace / project / mcp / diagnostics.
export type LocationRef = Wire<typeof Location.Ref>
export type LocationInfo = Wire<typeof Location.Info>
export type Workspace = Wire<typeof WorkspaceV2.Info>
export type WorkspaceAdapterEntry = Wire<typeof WorkspaceV2.AdapterEntry>
export type Project = Wire<typeof ProjectV2.Info>
export type McpStatus = Wire<typeof MCP.Status>
export type McpServerStatus = Wire<typeof MCP.Status>
export type McpResource = Wire<typeof MCP.Resource>
export type FormatterStatus = Wire<typeof FormatView.FormatterStatus>
export type LspStatus = Wire<typeof LspView.LspStatus>
