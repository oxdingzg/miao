import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { FormatterHandler } from "./handlers/formatter"
import { ConfigHandler } from "./handlers/config"
import { LspHandler } from "./handlers/lsp"
import { McpHandler } from "./handlers/mcp"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { ProjectHandler } from "./handlers/project"
import { RemoteHandler } from "./handlers/remote"
import { VcsHandler } from "./handlers/vcs"

export const handlers = Layer.mergeAll(
  HealthHandler,
  FormatterHandler,
  ConfigHandler,
  LspHandler,
  McpHandler,
  LocationHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  CredentialHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ReferenceHandler,
  ProjectCopyHandler,
  ProjectHandler,
  VcsHandler,
  RemoteHandler,
)
