// Shared type vocabulary for the direct interactive mode (`miao --mini`).
//
// Direct mode uses a split-footer terminal layout: immutable scrollback for the
// session transcript, and a mutable footer for prompt input, status, and
// permission/question UI. Every module in run/* shares these types to stay
// aligned on that two-lane model.
//
// Data flow through the system:
//
//   V2 session events → session-data reducer → StreamCommit[] + FooterOutput
//     → stream.ts bridges to footer API
//       → footer.ts queues commits and patches the footer view
//         → OpenTUI split-footer renderer writes to terminal
import type {
  Agent,
  Command,
  McpResource,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
  QuestionV2Answer,
  ToolPart,
} from "@miao/schema/view-models"
import { type Client } from "@/client"
import type { TuiConfig } from "@miao/tui/config"

export type RunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptModel = { providerID: string; modelID: string }

export type RunPromptPart =
  | (Omit<Extract<Part, { type: "text" }>, "sessionID" | "messageID" | "id"> & { id?: string })
  | (Omit<Extract<Part, { type: "file" }>, "sessionID" | "messageID" | "id"> & { id?: string })
  | (Omit<Extract<Part, { type: "agent" }>, "sessionID" | "messageID" | "id"> & { id?: string })

export type RunCommand = Command

export type RunProvider = Provider

export type RunPrompt = {
  messageID?: string
  partID?: string
  text: string
  parts: RunPromptPart[]
  mode?: "shell"
  command?: {
    name: string
    arguments: string
  }
}

export type FooterQueuedPrompt = {
  messageID: string
  partID: string
  prompt: RunPrompt
}

export type RunAgent = Agent

export type RunResource = McpResource

export type RunInput = {
  sdk: Client
  directory: string
  sessionID: string
  sessionTitle?: string
  resume?: boolean
  replay?: boolean
  replayLimit?: number
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
  backgroundSubagents: boolean
  demo?: boolean
}

// The semantic role of a scrollback entry. Maps 1:1 to theme colors.
export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

// Whether the assistant is actively processing a turn.
export type FooterPhase = "idle" | "running"

// Full snapshot of footer status bar state. Every update replaces the whole
// object in the SolidJS signal so the view re-renders atomically.
export type FooterState = {
  phase: FooterPhase
  status: string
  queue: number
  model: string
  duration: string
  usage: string
  first: boolean
  exit: number
}

// A partial update to FooterState. The footer merges this onto the current state.
export type FooterPatch = Partial<FooterState>

export type RunDiffStyle = "auto" | "stacked"

export type TurnSummary = {
  agent: string
  model: string
  duration: string
}

export type ScrollbackOptions = {
  diffStyle?: RunDiffStyle
  suppressBackgrounds?: boolean
}

export type ToolCodeSnapshot = {
  kind: "code"
  title: string
  content: string
  file?: string
}

export type ToolDiffSnapshot = {
  kind: "diff"
  items: Array<{
    title: string
    diff: string
    file?: string
    deletions?: number
  }>
}

export type ToolTaskSnapshot = {
  kind: "task"
  title: string
  rows: string[]
  tail: string
}

export type ToolTodoSnapshot = {
  kind: "todo"
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

export type ToolQuestionSnapshot = {
  kind: "question"
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

export type ToolSnapshot =
  | ToolCodeSnapshot
  | ToolDiffSnapshot
  | ToolTaskSnapshot
  | ToolTodoSnapshot
  | ToolQuestionSnapshot

export type EntryLayout = "inline" | "block"

export type RunEntryBody =
  | { type: "none" }
  | { type: "text"; content: string }
  | { type: "code"; content: string; filetype?: string }
  | { type: "markdown"; content: string }
  | { type: "structured"; snapshot: ToolSnapshot }

// Which interactive surface the footer is showing. Only one view is active at
// a time. The reducer drives transitions: when a permission arrives the view
// switches to "permission", and when the permission resolves it falls back to
// "prompt".
export type FooterView =
  | { type: "prompt" }
  | { type: "permission"; request: PermissionRequest }
  | { type: "question"; request: QuestionRequest }

export type FooterPromptRoute =
  | { type: "composer" }
  | { type: "queued-menu" }
  | { type: "subagent-menu" }
  | { type: "subagent"; sessionID: string }
  | { type: "command" }
  | { type: "skill" }
  | { type: "model" }
  | { type: "variant" }

export type FooterSubagentTab = {
  sessionID: string
  partID: string
  callID: string
  label: string
  description: string
  status: "running" | "completed" | "cancelled" | "error"
  background?: boolean
  title?: string
  toolCalls?: number
  lastUpdatedAt: number
}

export type FooterSubagentDetail = {
  sessionID: string
  commits: StreamCommit[]
}

export type FooterSubagentState = {
  tabs: FooterSubagentTab[]
  details: Record<string, FooterSubagentDetail>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

// The reducer emits this alongside scrollback commits so the footer can update in the same frame.
export type FooterOutput = {
  patch?: FooterPatch
  view?: FooterView
  subagent?: FooterSubagentState
}

// Typed messages sent to RunFooter.event(). The prompt queue and stream
// transport both emit these to update footer state without reaching into
// internal signals directly.
export type FooterEvent =
  | {
      type: "catalog"
      agents: RunAgent[]
      resources: RunResource[]
      commands?: RunCommand[]
    }
  | {
      type: "models"
      providers: RunProvider[]
    }
  | {
      type: "variants"
      variants: string[]
      current: string | undefined
    }
  | {
      type: "queue"
      queue: number
    }
  | {
      type: "queued.prompts"
      prompts: FooterQueuedPrompt[]
    }
  | {
      type: "first"
      first: boolean
    }
  | {
      type: "model"
      model: string
    }
  | {
      type: "turn.send"
      queue: number
    }
  | {
      type: "turn.wait"
    }
  | {
      type: "turn.idle"
      queue: number
    }
  | {
      type: "turn.duration"
      duration: string
    }
  | {
      type: "stream.patch"
      patch: FooterPatch
    }
  | {
      type: "stream.view"
      view: FooterView
    }
  | {
      type: "stream.subagent"
      state: FooterSubagentState
    }

// Replies go to the V2 routes, which address a request through the session
// that owns it (a subagent's child session for its blockers).
export type PermissionReply = Parameters<Client["permissions"]["reply"]>[0]

export type QuestionReply = {
  sessionID: string
  requestID: string
  answers: QuestionV2Answer[]
}

export type QuestionReject = Parameters<Client["questions"]["reject"]>[0]

export type RunTuiConfig = Pick<TuiConfig.Resolved, "keybinds" | "leader_timeout" | "diff_style">

// Lifecycle phase of a scrollback entry. "start" opens the entry, "progress"
// appends content (coalesced in the footer queue), "final" closes it.
export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamToolState = "running" | "completed" | "error"

// A single append-only commit to scrollback. The session-data reducer produces
// these from SDK events, and RunFooter.append() queues them for the next
// microtask flush. Once flushed, they become immutable terminal scrollback
// rows -- they cannot be rewritten.
export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  summary?: TurnSummary
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  interrupted?: boolean
  toolState?: StreamToolState
  toolError?: string
  shell?: {
    callID: string
    command: string
  }
}

export type LocalReplayAnchor = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  messageID?: string
  partID?: string
  toolState?: StreamToolState
  visible?: string
}

export type LocalReplayRow = {
  commit: StreamCommit
  after?: LocalReplayAnchor
}

// The public contract between the stream transport / prompt queue and
// the footer. RunFooter implements this. The transport and queue never
// touch the renderer directly -- they go through this interface.
export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (input: RunPrompt) => void): () => void
  onQueuedRemove(fn: (messageID: string) => boolean | Promise<boolean>): () => void
  onClose(fn: () => void): () => void
  event(next: FooterEvent): void
  append(commit: StreamCommit): void
  idle(): Promise<void>
  close(): void
  destroy(): void
}
