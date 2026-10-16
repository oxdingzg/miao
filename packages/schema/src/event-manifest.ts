import { EngineEvent } from "./engine-event"
export * as EventManifest from "./event-manifest"

import { Catalog } from "./catalog"
import { ConfigEvent } from "./config-event"
import { Durable } from "./durable-event-manifest"
import { Event } from "./event"
import { FileSystem } from "./filesystem"
import { FileSystemWatcher } from "./filesystem-watcher"
import { InstallationEvent } from "./installation-event"
import { Integration } from "./integration"
import { LegacyEvent } from "./legacy-event"
import { LspEvent } from "./lsp-event"
import { McpEvent } from "./mcp-event"
import { ModelsCatalog } from "./models-catalog"
import { Permission } from "./permission"
import { PermissionV1 } from "./permission-v1"
import { Plugin } from "./plugin"
import { Project } from "./project"
import { ProjectDirectories } from "./project-directories"
import { Pty } from "./pty"
import { Question } from "./question"
import { QuestionV1 } from "./question-v1"
import { Reference } from "./reference"
import { ServerEvent } from "./server-event"
import { SessionCompactionEvent } from "./session-compaction-event"
import { SessionEvent } from "./session-event"
import { SessionStatusEvent } from "./session-status-event"
import { SessionTodo } from "./session-todo"
import { SessionV1 } from "./session-v1"
import { TuiEvent } from "./tui-event"
import { VcsEvent } from "./vcs-event"
import { WorkspaceEvent } from "./workspace-event"
import { WorktreeEvent } from "./worktree-event"

const sessionV1DurableDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined)
const sessionV1LiveDefinitions = SessionV1.Event.Definitions.filter((definition) => definition.durable === undefined)

const coreDefinitions = Event.inventory(...sessionV1DurableDefinitions, ...SessionEvent.Definitions)

const foundationDefinitions = Event.inventory(
  ...ModelsCatalog.Event.Definitions,
  ...Integration.Event.Definitions,
  ...Catalog.Event.Definitions,
  ...coreDefinitions,
)

const featureDefinitions = Event.inventory(
  ...ConfigEvent.Definitions,
  ...WorktreeEvent.Definitions,
  ...FileSystem.Event.Definitions,
  ...Project.Event.Definitions,
  ...Reference.Event.Definitions,
  ...Permission.Event.Definitions,
  ...Plugin.Event.Definitions,
  ...ProjectDirectories.Event.Definitions,
  ...FileSystemWatcher.Event.Definitions,
  ...Pty.Event.Definitions,
  ...Question.Event.Definitions,
)

// Bridged events the TUI renders. `Definitions` already lists them through their families;
// `/api/event` carries only server definitions, so attached TUIs need them here too.
// The native bridge publishes `session.next.*` onto the client fan-out, and a
// type missing here fails `clientEvent` validation — the delivery fiber dies
// on the first settlement and attached clients silently lose the whole live
// stream (text, tool, and step events alike).
const tuiBridgeDefinitions = Event.inventory(
  LspEvent.Updated,
  VcsEvent.BranchUpdated,
  TuiEvent.ToastShow,
  SessionV1.Event.Error,
  ...SessionEvent.Definitions,
)

export const ServerDefinitions = Event.inventory(
  ...EngineEvent.Definitions,
  ...foundationDefinitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...tuiBridgeDefinitions,
  // Tells a client the authorization URL when the server host could not open a browser.
  McpEvent.BrowserOpenFailed,
)

export const Definitions = Event.inventory(
  ...EngineEvent.Definitions,
  ...foundationDefinitions,
  ...sessionV1LiveDefinitions,
  ...InstallationEvent.Definitions,
  ...featureDefinitions,
  ...SessionTodo.Event.Definitions,
  ...LspEvent.Definitions,
  ...PermissionV1.Event.Definitions,
  ...TuiEvent.Definitions,
  ...McpEvent.Definitions,
  ...LegacyEvent.Definitions,
  ...SessionStatusEvent.Definitions,
  ...QuestionV1.Event.Definitions,
  ...SessionCompactionEvent.Definitions,
  ...VcsEvent.Definitions,
  ...WorkspaceEvent.Definitions,
  ...ServerEvent.Definitions,
)
export const Latest = Event.latest(Definitions)
export { Durable }
