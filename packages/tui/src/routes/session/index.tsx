import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import { createStore } from "solid-js/store"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, type Renderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  TranscriptAssistantMessage,
  TranscriptToolPart,
  TranscriptUserMessage,
  TranscriptTextPart,
  TranscriptReasoningPart,
} from "@miao/schema/view-models"
import { toolOutputText } from "../../context/session-v2"
import { promptInfoFromUserMessage } from "../../context/session-v2-write"

import type { Provider, SessionStatus } from "@miao/schema/view-models"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { fileToolSummary, toolDisplay, toolDisplayMetadata, webSearchProviderLabel } from "../../util/tool-display"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SessionScrollbox } from "./scrollbox"
import { SubagentFooter } from "./subagent-footer.tsx"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { SessionActivity, latestSubagentPartID, orderTaskBlocks, subagentActivity, subagentResult, subagentRunning } from "./activity"
import { SessionMessageContent } from "./session-message"
import { PromptStatus } from "./prompt-status"
import { providerErrorText } from "./provider-failure"
import type { PendingPrompt } from "../../context/pending-prompts"
import { parseSessionMessage } from "../../util/session-message"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import {
  nextThinkingMode,
  reasoningDone,
  reasoningSummary,
  useThinkingMode,
  type ThinkingMode,
} from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { stdinPreview } from "../../util/stdin-preview"
import { createScrollAnchoring, createTranscriptWindow, type ScrollAnchorGeometry } from "../../util/transcript-window"
import { createDiffHighlighter } from "../../util/diff-context-highlight"
import { shellSegments } from "../../util/shell-highlight"
import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { MIAO_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])
// Identifies the leading spacer box among the scrollbox children so scroll
// anchoring can skip the fixed boxes that never move with the content.
const TRANSCRIPT_TOP_SPACER = "transcript-top-spacer"

export const alwaysSeparate = new WeakSet<BoxRenderable>()

// Which inline subagent blocks are expanded, keyed by the task part's id so the
// state survives route changes and is reachable from the toggle command.
const [inlineSubagentExpanded, setInlineSubagentExpanded] = createStore<Record<string, boolean>>({})

type RetryAction = Extract<SessionStatus, { type: "retry" }>["action"]

function goUpsellKeys(action: RetryAction) {
  if (!action) return
  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return {
      lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT,
      dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW,
    }
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    }
  }
}

const sessionBindingCommands = [
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.subagent.toggle",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.location.directory, workspaceID: current.location.workspaceID } : undefined
  })

  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const displayMessages = createMemo(() => sync.prompt.messages(route.sessionID, messages()))
  const transcript = createTranscriptWindow(displayMessages)
  createEffect(
    on(
      () => route.sessionID,
      () => transcript.reset(),
    ),
  )
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLastIndex(
      (message) => message.type === "assistant" && message.time.completed !== undefined,
    )
    const pending = messages().findLastIndex(
      (message, index) => index > completed && message.type === "assistant" && message.time.completed === undefined,
    )
    return pending === -1 ? undefined : pending
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.type === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  // The sidebar's 42 is its content width; its 2+2 padding sits outside it, so
  // reserve the full column (46) or the main area's last columns are clipped.
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 46 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    // Keep this session's transcript resident while the route shows it.
    sync.session.pin(sessionID)
    onCleanup(() => sync.session.unpin(sessionID))
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.api.sessions.get({ sessionID }, {}).then((x) => ({ data: x }))
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.location.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.location.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.location.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  // Restores the content under the viewport after window moves and prepended
  // pages, in the frame after the mutation has laid out.
  const anchoring = createScrollAnchoring<Renderable>({
    atBottom: () => Boolean(scroll && !scroll.isDestroyed && scroll.scrollTop >= scroll.scrollHeight - scroll.height - 1),
  })
  let jumpTo: { target: number; tries: number } | undefined
  let bottomPin: { tries: number } | undefined
  // Follow passes since the window last mutated. A mutation surfaces as mixed
  // stale/fresh layout for a couple of passes, so anchors are only captured
  // from settled geometry.
  let followPass = 0
  let lastMutation = -10
  const anchoringSettled = () => followPass - lastMutation >= 2
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (!evt.properties.status.action) return
    if (dialog.stack.length > 0) return

    const keys = goUpsellKeys(evt.properties.status.action)
    if (!keys) return

    const seen = kv.get(keys.lastSeenAt)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(keys.dontShow)) return

    void DialogRetryAction.show(dialog, evt.properties.status.action).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(keys.dontShow, true)
      kv.set(keys.lastSeenAt, Date.now())
    })
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // A readable user message is one that carries text
        return message.type === "user" && message.text.trim().length > 0
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      if (direction === "prev") loadOlderAtTop()
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function jumpToMessage(id: string) {
    // Revealing remounts the row at the window start, where everything above
    // it is the leading spacer: its content offset is exact, so the jump can
    // be positioned absolutely instead of waiting to measure the row.
    if (transcript.reveal(id)) {
      jumpTo = { target: transcript.top() + 1, tries: 0 }
      return
    }
    if (!scroll || scroll.isDestroyed) return
    const child = scroll.getChildren().find((child) => child.id === id)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
  }

  function toBottom() {
    transcript.reset()
    anchoring.drop()
    jumpTo = undefined
    bottomPin = { tries: 0 }
  }

  const local = useLocal()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              jumpToMessage(messageID)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              jumpToMessage(messageID)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.api.sessions.compact({ sessionID: route.sessionID })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.api.sessions.interrupt({ sessionID: route.sessionID }).catch(() => {})
        const message = messagesBeforeRevert().findLast((item) => item.type === "user")
        if (!message) return
        void sdk.api.sessions.stage({ sessionID: route.sessionID, messageID: message.id }).then(() => {
          toBottom()
        })
        prompt?.set(promptInfoFromUserMessage(message as TranscriptUserMessage))
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.type === "user" && x.id > messageID)
        if (!message) {
          void sdk.api.sessions.clear({ sessionID: route.sessionID })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.api.sessions.stage({ sessionID: route.sessionID, messageID: message.id })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        loadOlderAtTop()
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        loadOlderAtTop()
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        loadOlderAtTop()
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        loadOlderAtTop()
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with readable text
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.type !== "user") continue
          if (message.text.trim().length === 0) continue
          jumpToMessage(message.id)
          break
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.type === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const text = lastAssistantMessage.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(sessionData, sessionMessages,
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(sessionData, sessionMessages,
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result =
              process.env.VISUAL || process.env.EDITOR
                ? await openEditor({
                    renderer,
                    value: transcript,
                    cwd:
                      (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                      project.instance.directory() ||
                      paths.cwd,
                  })
                : undefined
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Toggle inline subagent transcript",
      value: "session.subagent.toggle",
      category: "Session",
      hidden: true,
      run: () => {
        const id = latestSubagentPartID(messages())
        if (id) setInlineSubagentExpanded(id, (value) => !value)
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: MIAO_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertMessageIndex = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return -1
    return messages().findIndex((message) => message.id === messageID)
  })

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    const index = revertMessageIndex()
    if (index === -1) return []
    return messages()
      .slice(index)
      .filter((message) => message.type === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  // Older history is paged in only when the reader actually reaches the top, so
  // a long session never pays for its whole timeline up front. Prepended rows
  // shift the viewport, so restore the reader's place once layout catches up.
  createEffect(() => {
    const id = revertMessageID()
    if (id) transcript.reveal(id)
  })

  let loadingHistory = false
  async function loadOlder() {
    if (!scroll || scroll.isDestroyed || loadingHistory || transcript.start() > 0) return
    loadingHistory = true
    const sessionID = route.sessionID
    const boundary = transcript.messages()[0]?.id
    const captured = anchoringSettled() ? anchoring.capture(anchorGeometry()) : undefined
    const loaded = await sync.session.loadOlder(sessionID).catch(() => false)
    loadingHistory = false
    if (sessionID !== route.sessionID || !loaded) return
    // Anchor the window on the message that was at the top so the prepended
    // page stays above the reader and only the spacers grow; the anchor puts
    // the exact offset back once the frame lays out, without timers.
    if (boundary) transcript.reveal(boundary)
    if (captured) anchoring.arm(captured)
  }

  function loadOlderAtTop() {
    if (!scroll || scroll.isDestroyed) return
    if (scroll.scrollTop > 1) return
    void loadOlder()
  }

  // Geometry of the scroll content for scroll anchoring. The leading spacer is
  // identified by id so the fixed boxes before the first message row are
  // never chosen as anchors.
  function anchorGeometry(): ScrollAnchorGeometry<Renderable> | undefined {
    if (!scroll || scroll.isDestroyed || scroll.scrollHeight <= 0) return undefined
    const rows = scroll.getChildren()
    const spacer = rows.findIndex((child) => child.id === TRANSCRIPT_TOP_SPACER)
    return {
      rows,
      from: Math.max(1, spacer + 1),
      contentTop: scroll.content.y,
      scrollHeight: scroll.scrollHeight,
    }
  }

  function applyJump() {
    const pending = jumpTo
    if (!pending) return
    if (!scroll || scroll.isDestroyed) {
      jumpTo = undefined
      return
    }
    // Wait for the revealed window to lay out, then land the row with an
    // absolute scroll position; no per-frame measurement needed.
    if (scroll.scrollHeight <= pending.target && ++pending.tries < 10) return
    jumpTo = undefined
    scroll.scrollTo(pending.target)
  }

  function applyBottom() {
    const pending = bottomPin
    if (!pending) return
    if (!scroll || scroll.isDestroyed) {
      bottomPin = undefined
      return
    }
    if (scroll.scrollHeight <= 0 && ++pending.tries < 10) return
    bottomPin = undefined
    scroll.scrollTo(scroll.scrollHeight)
  }

  // Keep the mounted window around the viewport. Spacers preserve the height of
  // the whole loaded timeline, so the scrollbar and scroll position stay put
  // while only the rows near the reader remain mounted.
  function followWindow(shared?: ScrollAnchorGeometry<Renderable>) {
    if (!scroll || scroll.isDestroyed || loadingHistory) return
    // Lifecycle passes run before layout, so the scrollbox may still report no
    // geometry. That is only transient: retry on the next frame instead of
    // giving up, or a transcript that mounted before its first layout would
    // never follow the viewport and every message would stay mounted.
    if (scroll.scrollHeight <= 0) {
      requestAnimationFrame(() => followWindow())
      return
    }
    followPass++
    const geometry = shared ?? anchorGeometry()
    const before = { start: transcript.start(), top: transcript.top(), bottom: transcript.bottom() }
    const captured = anchoringSettled() ? anchoring.capture(geometry) : undefined
    transcript.follow({
      scrollTop: scroll.scrollTop,
      viewportHeight: scroll.height,
      mountedHeight: scroll.scrollHeight - transcript.top() - transcript.bottom(),
    })
    // Compensate only mutations of the window itself; organic content changes
    // above the viewport keep moving it, as before.
    if (
      transcript.start() !== before.start ||
      transcript.top() !== before.top ||
      transcript.bottom() !== before.bottom
    ) {
      lastMutation = followPass
      if (captured) anchoring.arm(captured)
    }
  }

  return (
    <LocationProvider location={location()}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minWidth={0} minHeight={0} paddingBottom={1} paddingLeft={1} paddingRight={1} gap={1}>
            <Show when={session()}>
              <SessionScrollbox
                ref={(r) => {
                  scroll = r
                  const pass = r.onLifecyclePass
                  r.onLifecyclePass = () => {
                    pass?.call(r)
                    const geometry = anchorGeometry()
                    if (geometry) anchoring.apply(geometry, (delta) => scroll?.scrollBy(delta))
                    applyJump()
                    applyBottom()
                    followWindow(geometry)
                  }
                  r.ctx.registerLifecyclePass(r)
                }}
                alwaysShow={showScrollbar()}
                thumbColor={theme.border}
                trackColor={theme.backgroundElement}
                hiddenColor={theme.background}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
                onMouseScroll={(event) => {
                  if (event.scroll?.direction === "up") loadOlderAtTop()
                }}
              >
                <box height={1} />
                <Show when={route.fresh && displayMessages().length === 0}>
                  <box paddingLeft={3} flexShrink={0}>
                    <text>
                      <span style={{ fg: theme.success }}>✓ </span>
                      Context cleared — new session started
                    </text>
                    <text style={{ fg: theme.textMuted }}>
                      The previous conversation is still available via /sessions
                    </text>
                  </box>
                </Show>
                <Show when={transcript.start() > 0}>
                  <box paddingLeft={3} onMouseUp={() => void loadOlder()}>
                    <text fg={theme.textMuted}>↑ Scroll up or click to load earlier messages</text>
                  </box>
                </Show>
                <Show when={transcript.top() > 0}>
                  <box id={TRANSCRIPT_TOP_SPACER} height={transcript.top()} flexShrink={0} />
                </Show>
                <For each={transcript.messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const redoShortcut = useCommandShortcut("session.redo")
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              keymap.dispatchCommand("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match
                        when={
                          revert()?.messageID &&
                          revertMessageIndex() !== -1 &&
                          index() + transcript.start() >= revertMessageIndex()
                        }
                      >
                        <></>
                      </Match>
                      <Match when={message.type === "compaction"}>
                        <box marginTop={1} border={["top"]} title=" Compaction " titleAlignment="center" borderColor={theme.borderActive} />
                      </Match>
                      <Match when={message.type === "user"}>
                        <UserMessage
                          index={index() + transcript.start()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText() || sync.prompt.data[message.id]) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as TranscriptUserMessage}
                          pending={pending()}
                          receipt={sync.prompt.data[message.id]}
                        />
                      </Match>
                      <Match when={message.type === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          sessionID={route.sessionID}
                          message={message as TranscriptAssistantMessage}
                        />
                      </Match>
                      <Match when={true}>
                        <></>
                      </Match>
                    </Switch>
                  )}
                </For>
                <Show when={transcript.bottom() > 0}>
                  <box height={transcript.bottom()} flexShrink={0} />
                </Show>
                <SessionActivity sessionID={route.sessionID} />
              </SessionScrollbox>
              <box flexShrink={0}>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.location.directory}
                    onSettled={(request) => sync.dismissPermission(request.sessionID, request.id)}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions()[0]} keyed>
                  {(request) => (
                    <QuestionPrompt
                      request={request}
                      directory={sync.session.get(request.sessionID)?.location.directory}
                      onSettled={(settled) => sync.dismissQuestion(settled.sessionID, settled.id)}
                    />
                  )}
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </pluginRuntime.Slot>
                </Show>
              </box>
            </Show>
            <Toast />
          </box>
          <Show when={sidebarVisible()}>
            <Switch>
              <Match when={wide()}>
                <Sidebar sessionID={route.sessionID} />
              </Match>
              <Match when={!wide()}>
                <box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  alignItems="flex-end"
                  backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                >
                  <Sidebar sessionID={route.sessionID} />
                </box>
              </Match>
            </Switch>
          </Show>
        </box>
      </context.Provider>
    </LocationProvider>
  )
}

function UserMessage(props: {
  message: TranscriptUserMessage
  onMouseUp: () => void
  index: number
  pending?: number
  receipt?: PendingPrompt
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.message.text)
  const sessionMessage = createMemo(() => parseSessionMessage(text()))
  const files = createMemo(() => props.message.files ?? [])
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending !== undefined && props.index > props.pending)
  const command = createMemo(() => props.message.command)
  const color = createMemo(
    () => local.agent.color(command()?.agent ?? props.message.agents?.at(-1)?.name ?? ""),
  )
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => Boolean(props.receipt) || queued() || ctx.showTimestamps())

  return (
    <>
      <Show when={text() || command()}>
        <box
          id={props.message.id}
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <Show
              when={command()}
              fallback={
                <Show when={sessionMessage()} fallback={<text fg={theme.text}>{text()}</text>}>
                  {(message) => (
                    <SessionMessageContent
                      sessionID={message().sessionID}
                      body={message().body}
                      title={ctx.sync.session.get(message().sessionID)?.title}
                      conceal={ctx.conceal()}
                      compact={Boolean(props.receipt)}
                    />
                  )
                  }
                </Show>
              }
            >
              {(value) => (
                <text fg={theme.text}>
                  {`/${value().name}${value().arguments ? ` ${value().arguments}` : ""}`}
                </text>
              )}
            </Show>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>
                          {" "}{file.name ?? file.uri}{" "}
                        </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show when={props.receipt}>{(receipt) => <PromptStatus prompt={receipt()} />}</Show>
            <Show
              when={!props.receipt && queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: TranscriptAssistantMessage; sessionID: string; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const model = createMemo(() => Model.name(ctx.providers(), props.message.model.providerID, props.message.model.id))
  // V2 errors are untyped `{ type: "unknown", message }`; an aborted turn is
  // recognized by its abort message text.
  const aborted = createMemo(() => props.message.error?.message.toLowerCase().includes("abort") ?? false)

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    return props.message.time.completed - props.message.time.created
  })

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")
  const tools = createMemo(() => props.message.content.filter((part): part is TranscriptToolPart => part.type === "tool"))
  // One block per subagent with the running ones on top; only sibling tool
  // parts reorder among themselves, so the timeline itself stays honest.
  const content = createMemo(() => orderTaskBlocks(props.message.content))

  return (
    <>
      <For each={content()}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === content().length - 1}
                component={component()}
                part={part as any}
                message={props.message}
                sessionID={props.sessionID}
              />
            </Show>
          )
        }}
      </For>
      <Show when={tools().some((x) => x.name === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={
                sync.data.capabilities.experimentalBackgroundSubagents &&
                tools().some(
                  (x) =>
                    x.name === "task" &&
                    x.state.status === "running" &&
                    (x.state as { metadata?: { background?: boolean } }).metadata?.background !== true,
                )
              }
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && !aborted()}>
        <box
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.error}>{providerErrorText(errorMessage(props.message.error))}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || aborted()}>
          <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={2}>
            <text marginTop={1} fg={theme.textMuted}>
              {Locale.titlecase(props.message.agent)}
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={aborted()}>
                <span style={{ fg: theme.warning }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2
const INLINE_TOOL_ICON = "●"

function ReasoningPart(props: {
  last: boolean
  part: TranscriptReasoningPart
  message: TranscriptAssistantMessage
  sessionID: string
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const hidden = createMemo(() => ctx.thinkingMode() === "hide")

  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const opaque = createMemo(() => !content() && Boolean(props.part.providerMetadata))
  // Hide mode keeps thinking out of the transcript, except for a duration-only
  // line when the step has no text of its own: models that do not narrate
  // between tool calls (DeepSeek) otherwise look like they never reasoned.
  // Narrating models and opaque reasoning stay hidden so long turns do not
  // gain a row per step.
  const visible = createMemo(() => {
    if (!hidden()) return Boolean(content() || opaque())
    if (!content()) return false
    return !props.message.content.some((part) => part.type === "text" && part.text.trim())
  })
  const isDone = createMemo(() =>
    reasoningDone(props.part, props.message, sync.data.session_status[props.sessionID]),
  )
  const duration = createMemo(() => {
    const completed = props.part.time?.completed
    return completed === undefined
      ? undefined
      : Locale.duration(Math.max(0, completed - (props.part.time?.created ?? 0)))
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

  return (
    <Show when={visible()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <ReasoningHeader done={isDone()} duration={isDone() ? duration() : undefined} />
        <Show when={!hidden() && !opaque() && summary().body}>
          <box marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={!isDone()}
              syntaxStyle={syntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: { done: boolean; duration?: string }) {
  const { theme } = useTheme()
  // Theme fields are store reads; keep them inside a thunk so a theme switch
  // repaints the header instead of freezing the color it was mounted with.
  const fg = () => theme.textMuted
  // Claude Code style: a plain label while thinking, then only how long it took.
  // The raw reasoning stays behind the thinking toggle instead of leaking a
  // provider-language headline into the transcript.
  const completed = () => (props.duration ? `Thought for ${props.duration}` : "Thought")

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()}>Thinking</Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          {completed()}
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TranscriptTextPart; message: TranscriptAssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const content = createMemo(() => props.part.text.trim())
  // Re-parsing the whole accumulated Markdown on every token delta is O(n^2)
  // across a stream. Leading+trailing throttle bounds parsing to ~20/s while
  // still rendering the final text.
  const [rendered, setRendered] = createSignal(content())
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | undefined
  createEffect(() => {
    const value = content()
    if (timer === undefined) {
      setRendered(value)
      timer = setTimeout(() => {
        timer = undefined
        if (pending !== undefined) {
          setRendered(pending)
          pending = undefined
        }
      }, 50)
      return
    }
    pending = value
  })
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  return (
    <Show when={rendered()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={0}
        marginTop={1}
        flexDirection="row"
        flexShrink={0}
      >
        <text fg={theme.textMuted}>● </text>
        <box flexGrow={1} minWidth={0}>
          <markdown
            syntaxStyle={syntax()}
            streaming={props.message.time.completed === undefined}
            // Keep incremental blocks while streaming, then coalesce finished
            // prose so long histories retain fewer native text buffers.
            internalBlockMode={props.message.time.completed === undefined ? "top-level" : "coalesced"}
            content={rendered()}
            tableOptions={{ style: "grid" }}
            conceal={ctx.conceal()}
            fg={theme.markdownText}
            bg={theme.background}
          />
        </box>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: TranscriptToolPart; message: TranscriptAssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.name))
  const state = props.part.state

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (props.part.name === "send_message") return false
    if (ctx.showDetails()) return false
    if (state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return state.status === "pending" ? {} : ((state as { metadata?: Record<string, unknown> }).metadata ?? {})
    },
    get input() {
      return typeof state.input === "object" && state.input !== null ? (state.input as Record<string, unknown>) : {}
    },
    get output() {
      return state.status === "completed" ? toolOutputText(state) : undefined
    },
    get tool() {
      return props.part.name
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.name === "send_message" && state.status === "completed"}>
          <SentSessionMessage {...toolprops} />
        </Match>
        <Match when={display() === "bash"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={display() === "execute"}>
          <Execute {...toolprops} />
        </Match>
        <Match when={display() === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: TranscriptToolPart
}

function SentSessionMessage(props: ToolProps) {
  const ctx = use()
  const sync = useSync()
  const [expanded, setExpanded] = createSignal(false)
  const target = createMemo(() =>
    typeof props.metadata.sessionID === "string" ? props.metadata.sessionID : String(props.input.to ?? ""),
  )
  const title = createMemo(() => sync.data.session.find((session) => session.id === target())?.title)
  return (
    <box onMouseUp={() => setExpanded((value) => !value)}>
      <SessionMessageContent
        sessionID={target()}
        title={title()}
        body={typeof props.input.message === "string" ? props.input.message : ""}
        conceal={true}
        compact={!ctx.showDetails() && !expanded()}
        direction="sent"
      />
    </box>
  )
}

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const collapsed = createMemo(() => collapseToolOutput(output(), 3, 3 * Math.max(20, ctx.width - 8)))
  const args = createMemo(() => input(props.input))
  const title = createMemo(() =>
    Locale.truncate(args().replace(/\s+/g, " "), Math.max(20, ctx.width - props.tool.length - 10)),
  )
  const details = createMemo(() => collapsed().overflow || title() !== args())

  return (
    <box>
      <InlineTool
        icon={INLINE_TOOL_ICON}
        pending="Preparing tool…"
        complete={true}
        spinner={props.part.state.status === "running"}
        part={props.part}
        onClick={details() ? () => setExpanded((value) => !value) : undefined}
      >
        <b>{props.tool}</b> {title()}
      </InlineTool>
      <Show when={expanded() && title() !== args()}>
        <FileToolResult summary={args()} color={theme.textMuted} />
      </Show>
      <Show when={output() && ctx.showGenericToolOutput()}>
        <FileToolResult summary={expanded() ? output() : collapsed().output.replace(/\n…$/, "")} color={theme.text} />
      </Show>
      <Show when={details()}>
        <box paddingLeft={2} onMouseUp={() => setExpanded((value) => !value)}>
          <text fg={theme.textMuted}>{expanded() ? "Show less" : "… click to expand"}</text>
        </box>
      </Show>
    </box>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  /** Highlighted content shown after the label, e.g. the command a shell row ran. */
  code?: JSX.Element
  part: TranscriptToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.id
  })

  const error = createMemo(() =>
    props.part.state.status === "error" ? props.part.state.error.message : undefined,
  )

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      separate={props.separate}
      code={props.code}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  code?: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={0}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={0}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={props.code ? 0 : 1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
              <Show when={props.code && !(props.failed && !props.complete)}>
                <box flexGrow={1} minWidth={0} paddingLeft={1}>
                  {props.code}
                </box>
              </Show>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: TranscriptToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() =>
    props.part?.state.status === "error" ? props.part.state.error.message : undefined,
  )
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{title().replace(/^# /, "")}</Spinner>
          </Show>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const command = createMemo(() => stringValue(props.input.command) ?? "")
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output) ?? props.output ?? "").trim())
  const preview = createMemo(() =>
    output()
      .replace(/(?:^|\n)\[exit code 0\]\s*$/, "")
      .trim(),
  )
  const [expanded, setExpanded] = createSignal(false)
  const collapsed = createMemo(() => collapseToolOutput(preview(), 3, 3 * Math.max(20, ctx.width - 8)))
  const title = createMemo(() => Locale.truncate(command().split("\n", 1)[0].trim(), Math.max(20, ctx.width - 12)))
  const stdin = createMemo(() => {
    const value = stringValue(props.input.stdin)
    return value === undefined ? undefined : stdinPreview(value, 3, 3 * Math.max(20, ctx.width - 8))
  })
  const details = createMemo(
    () => command() !== title() || collapsed().overflow || Boolean(props.input.workdir) || stdin() !== undefined,
  )

  return (
    <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} marginTop={1}>
      <InlineTool
        icon="●"
        iconColor={props.part.state.status === "completed" ? theme.success : undefined}
        color={theme.text}
        pending="Preparing command…"
        complete={command()}
        spinner={isRunning()}
        part={props.part}
        onClick={details() ? () => setExpanded((value) => !value) : undefined}
        code={
          isRunning() ? undefined : (
            <code conceal={false} fg={theme.text} filetype="bash" syntaxStyle={syntax()} content={title()} />
          )
        }
      >
        <Show when={isRunning()} fallback={<b>Ran</b>}>
          <b>Running</b> {title()}
        </Show>
      </InlineTool>
      <Show when={expanded()}>
        <box paddingLeft={2}>
          <Show when={stringValue(props.input.workdir)}>
            <text fg={theme.textMuted}>in {pathFormatter.format(stringValue(props.input.workdir))}</text>
          </Show>
          <For each={shellSegments(command())}>
            {(segment) => (
              <code
                conceal={false}
                fg={theme.text}
                filetype={segment.filetype}
                syntaxStyle={syntax()}
                content={segment.content}
              />
            )}
          </For>
        </box>
      </Show>
      <Show when={stdin()}>
        {(item) => (
          <box paddingLeft={2}>
            <text fg={theme.textMuted}>{item().heading}</text>
            <text fg={theme.text}>{expanded() ? stringValue(props.input.stdin) : item().output}</text>
          </box>
        )}
      </Show>
      <Show when={expanded() ? output() : preview()}>
        <FileToolResult summary={expanded() ? output() : collapsed().output.replace(/\n…$/, "")} color={theme.text} />
      </Show>
      <Show when={details()}>
        <box paddingLeft={2} onMouseUp={() => setExpanded((value) => !value)}>
          <text fg={theme.textMuted}>{expanded() ? "Show less" : "… click to view command and output"}</text>
        </box>
      </Show>
    </box>
  )
}

function Write(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const [expanded, setExpanded] = createSignal(false)
  const filePath = createMemo(() => stringValue(props.input.filePath))
  const code = createMemo(() => stringValue(props.input.content) ?? "")
  const error = createMemo(() =>
    props.part.state.status === "error" ? props.part.state.error.message : undefined,
  )
  // What a write wrote is the point of the row, so it previews the way a command
  // previews its output and the click reveals the rest. This used to hang off
  // `diagnostics`, which the tool only reports when the language server found
  // errors, so every clean write rendered as a bare line.
  const collapsed = createMemo(() => collapseToolOutput(code(), 3, 3 * Math.max(20, ctx.width - 8)))

  return (
    <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} marginTop={1}>
      <InlineTool
        icon="●"
        iconColor={props.part.state.status === "completed" ? theme.success : undefined}
        color={theme.text}
        pending="Preparing write…"
        complete={true}
        spinner={props.part.state.status === "running"}
        part={props.part}
        onClick={() => setExpanded((value) => !value)}
      >
        <b>Write</b>({pathFormatter.format(filePath())})
      </InlineTool>
      <FileToolResult
        summary={error() ?? fileToolSummary("write", props.metadata) ?? "Wrote file"}
        color={error() ? theme.error : theme.text}
      >
        <Show when={!error()}>
          <Show
            when={expanded() || !collapsed().overflow}
            fallback={
              <box onMouseUp={() => setExpanded(true)}>
                <code
                  conceal={false}
                  fg={theme.text}
                  filetype={filetype(filePath())}
                  syntaxStyle={syntax()}
                  content={collapsed().output.replace(/\n?…$/, "")}
                />
              </box>
            }
          >
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(filePath())}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
          </Show>
        </Show>
        <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath() ?? ""} />
      </FileToolResult>
      <Show when={!error() && collapsed().overflow}>
        <box paddingLeft={2} onMouseUp={() => setExpanded((value) => !value)}>
          <text fg={theme.textMuted}>{expanded() ? "Show less" : "… click to view file"}</text>
        </box>
      </Show>
    </box>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool
      icon={INLINE_TOOL_ICON}
      pending="Finding files…"
      complete={stringValue(props.input.pattern)}
      part={props.part}
    >
      <b>Glob</b> "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const [expanded, setExpanded] = createSignal(false)
  const filepath = createMemo(() => pathFormatter.format(stringValue(props.input.filePath)))
  const title = createMemo(() => Locale.truncateMiddle(filepath(), Math.max(20, ctx.width - 24)))
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.time?.pruned) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="●"
        iconColor={props.part.state.status === "completed" ? theme.success : undefined}
        color={theme.text}
        pending="Reading file…"
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
        onClick={filepath() !== title() ? () => setExpanded((value) => !value) : undefined}
      >
        <b>Read</b> {title()}
      </InlineTool>
      <Show when={expanded()}>
        <FileToolResult summary={filepath()} color={theme.textMuted} />
      </Show>
      <Show when={props.part.state.status === "completed" && fileToolSummary("read", props.metadata)}>
        {(summary) => <FileToolResult summary={summary()} color={theme.textMuted} />}
      </Show>
      <For each={loaded()}>
        {(filepath) => <FileToolResult summary={`Loaded ${pathFormatter.format(filepath)}`} color={theme.textMuted} />}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool
      icon={INLINE_TOOL_ICON}
      pending="Searching content…"
      complete={stringValue(props.input.pattern)}
      part={props.part}
    >
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool
      icon={INLINE_TOOL_ICON}
      pending="Fetching from the web…"
      complete={stringValue(props.input.url)}
      part={props.part}
    >
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool
      icon={INLINE_TOOL_ICON}
      pending="Searching web…"
      complete={stringValue(props.input.query)}
      part={props.part}
    >
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const dialog = useDialog()
  const expandShortcut = useCommandShortcut("session.subagent.toggle")

  // The child Session link arrives while the call is still running: the task
  // tool checkpoints it into `state.structured` (V2) and the runner repeats it
  // in the completion output (legacy `metadata.sessionId`).
  const structured = createMemo(() => toolDisplayMetadata(props.part.state))
  const sessionID = createMemo(() => stringValue(structured().sessionID) ?? stringValue(props.metadata.sessionId))
  const background = createMemo(() => structured().background === true || props.metadata.background === true)

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    // The subagent transcript is rendered inline, so keep it resident until the
    // tool cell unmounts.
    sync.session.pin(id)
    onCleanup(() => sync.session.unpin(id))
    if (!sync.data.message[id]?.length) void sync.session.sync(id)
  })

  const childMessages = createMemo(() => sync.data.message[sessionID() ?? ""] ?? [])
  const childStatus = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const retry = createMemo(() => {
    const value = childStatus()
    return value?.type === "retry" ? value : undefined
  })
  const running = createMemo(() => subagentRunning(props.part.state.status, background(), childStatus()))
  const expanded = createMemo(() => inlineSubagentExpanded[props.part.id] ?? false)
  const toggle = () => setInlineSubagentExpanded(props.part.id, (value) => !value)

  // Claude Code keeps a live elapsed time on the subagent row for the whole run.
  // Tick only while the task is live so an idle row does not repaint every second.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!running()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const duration = createMemo(() => {
    const first = childMessages().find((x) => x.type === "user")?.time.created
    if (first !== undefined) {
      const completed = childMessages().findLast((x) => x.type === "assistant")?.time.completed
      const span = (completed ?? (running() ? now() : first)) - first
      // A completed child transcript whose final assistant message never
      // recorded a completion time yields 0ms; the call's own timing below
      // still reports the real duration.
      if (span > 0 || running()) return span
    }
    // The child transcript can lag behind the tool call, so fall back to the
    // call's own timing and still report how long the subagent has been running.
    const state = props.part.state
    const time = props.part.time
    if (state.status === "running") return Math.max(0, now() - (time?.created ?? 0))
    if (state.status === "completed") return Math.max(0, (time?.completed ?? 0) - (time?.created ?? 0))
    return 0
  })

  const title = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    return formatSubagentTitle(
      Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
      description,
      background(),
    )
  })

  // Collapsed, the row carries the live tail (latest tool lines) while running
  // and a one-line result summary once finished; expanding swaps the tail for
  // the child transcript itself. An errored row keeps the call icon and lets
  // InlineTool render the failure.
  const hint = createMemo(() => (sessionID() && expandShortcut() ? `… ${expandShortcut()} expand` : undefined))
  const detail = createMemo(() => {
    const retrying = retry()
    if (running()) {
      const elapsed = duration() > 0 ? ` · ${Locale.duration(duration())}` : ""
      if (retrying) return `↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}${elapsed}`
      if (expanded()) return `↳ ${formatSubagentRunningDetail(duration())}`
      const activity = subagentActivity(childMessages())
      const lines = activity.map((line, index) => `↳ ${line}${index === activity.length - 1 ? elapsed : ""}`)
      if (lines.length === 0) return `↳ ${formatSubagentRunningDetail(duration())}${hint() ? `\n${hint()}` : ""}`
      return [...lines, ...(hint() ? [hint()] : [])].join("\n")
    }
    if (props.part.state.status === "completed") {
      const result = subagentResult(props.output)
      return `↳ ${Locale.duration(duration())}${result ? ` · ${result}` : ""}`
    }
    return undefined
  })

  return (
    <>
      <InlineTool
        icon={props.part.state.status === "completed" ? "✓" : "│"}
        separate={true}
        color={retry() ? theme.error : undefined}
        spinner={running()}
        complete={stringValue(props.input.description)}
        pending="Delegating…"
        part={props.part}
        onClick={() => {
          if (sessionID()) toggle()
          const status = retry()
          if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
        }}
      >
        {[title(), detail()].filter(Boolean).join("\n")}
      </InlineTool>
      <Show when={expanded() && sessionID()}>
        <box paddingLeft={3} flexShrink={0}>
          <For each={childMessages()}>
            {(message) => (
              <Switch>
                <Match when={message.type === "user"}>
                  <UserMessage index={0} onMouseUp={() => {}} message={message as TranscriptUserMessage} />
                </Match>
                <Match when={message.type === "assistant"}>
                  <AssistantMessage
                    last={false}
                    sessionID={sessionID()!}
                    message={message as TranscriptAssistantMessage}
                  />
                </Match>
              </Switch>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatSubagentRunningDetail(elapsed: number) {
  return elapsed > 0 ? `Running · ${Locale.duration(elapsed)}` : "Running"
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true)
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  const showOutput = createMemo(() => output() && hasRuntimeError())
  const content = createMemo(() => {
    const lines = ["execute"]
    for (const call of calls()) {
      const args = input(call.input ?? {})
      lines.push(`↳ ${call.tool}${args ? ` ${args}` : ""}${call.status === "error" ? " (failed)" : ""}`)
    }
    return lines.join("\n")
  })

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.error : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
      >
        {content()}
      </InlineTool>
      <Show when={showOutput()}>
        <box paddingLeft={3}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.error}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

// The diff renderer highlights the visible hunk lines in isolation, so a hunk
// that opens inside a block comment or multi-line string loses highlighting.
// Read the file as it is now and highlight against it; the diff waits for that
// read because its renderer cannot swap highlighters after mounting, and any
// failure or mismatch falls back to the default highlighter.
function useDiffHighlighter(input: {
  patch: () => string
  filePath: () => string | undefined
  enabled: () => boolean
}) {
  const sdk = useSDK()
  const [current] = createResource(
    () => {
      const file = input.filePath()
      if (!input.enabled() || !file || !sdk.directory) return undefined
      const relative = path.relative(sdk.directory, path.resolve(sdk.directory, file))
      if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined
      return relative
    },
    (relative) =>
      sdk.api.files
        .content({ path: relative }, {})
        .then((result) => (result.data.type === "text" ? result.data.content : undefined))
        .catch(() => undefined),
  )
  return {
    ready: () => !current.loading,
    client: createMemo(() => {
      const text = current()
      return createDiffHighlighter({ patch: input.patch(), current: text })
    }),
  }
}

export function FileToolResult(props: { summary: string; color?: RGBA; children?: JSX.Element }) {
  return (
    <box paddingLeft={2} flexDirection="row">
      <text width={3} fg={props.color}>
        ⎿{" "}
      </text>
      <box flexGrow={1} minWidth={0}>
        <text fg={props.color}>{props.summary}</text>
        <Show when={props.children}>{props.children}</Show>
      </box>
    </box>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const ft = createMemo(() => filetype(stringValue(props.input.filePath)))

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")
  const [expanded, setExpanded] = createSignal(diffFitsInline(diffContent()))
  const highlighter = useDiffHighlighter({
    patch: diffContent,
    filePath: () => stringValue(props.input.filePath),
    enabled: expanded,
  })

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} marginTop={1}>
          <InlineTool
            icon="●"
            iconColor={props.part.state.status === "completed" ? theme.success : undefined}
            color={theme.text}
            pending="Preparing edit…"
            complete={true}
            part={props.part}
            onClick={() => setExpanded((value) => !value)}
          >
            <b>Update</b>({pathFormatter.format(stringValue(props.input.filePath))})
          </InlineTool>
          <FileToolResult summary={fileToolSummary("edit", props.metadata) ?? "Updated file"} color={theme.text}>
            <Show when={expanded() && highlighter.ready()}>
              <diff
                diff={diffContent()}
                view="unified"
                treeSitterClient={highlighter.client()}
                filetype={ft()}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={ctx.diffWrapMode()}
                fg={theme.text}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                contextBg={theme.background}
                addedSignColor={theme.diffHighlightAdded}
                removedSignColor={theme.diffHighlightRemoved}
                lineNumberFg={theme.diffLineNumber}
                lineNumberBg={theme.background}
                addedLineNumberBg={theme.diffAddedLineNumberBg}
                removedLineNumberBg={theme.diffRemovedLineNumberBg}
              />
            </Show>
            <Show when={!expanded()}>
              <text fg={theme.textMuted} onMouseUp={() => setExpanded(true)}>
                … click to view diff
              </text>
            </Show>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={stringValue(props.input.filePath) ?? ""} />
          </FileToolResult>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="●"
          color={theme.text}
          pending="Preparing edit…"
          complete={stringValue(props.input.filePath)}
          spinner={props.part.state.status === "running"}
          part={props.part}
        >
          <b>Update</b>({pathFormatter.format(stringValue(props.input.filePath))})
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    const highlighter = useDiffHighlighter({ patch: () => p.diff, filePath: () => p.filePath, enabled: () => true })
    return (
      <Show when={highlighter.ready()}>
        <box paddingLeft={1}>
          <diff
            diff={p.diff}
            view={view()}
            treeSitterClient={highlighter.client()}
            filetype={filetype(p.filePath)}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode={ctx.diffWrapMode()}
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.background}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.background}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </box>
      </Show>
    )
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => {
            const [expanded, setExpanded] = createSignal(diffFitsInline(file.patch))
            return (
              <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} marginTop={1}>
                <InlineTool
                  icon="●"
                  iconColor={theme.success}
                  color={theme.text}
                  pending="Preparing patch…"
                  complete={true}
                  part={props.part}
                  onClick={() => setExpanded((value) => !value)}
                >
                  <b>{file.type === "delete" ? "Deleted" : file.type === "add" ? "Created" : "Patched"}</b>{" "}
                  {file.relativePath}
                </InlineTool>
                <FileToolResult
                  summary={file.type === "delete" ? `Removed ${file.deletions} lines` : "Updated file"}
                  color={theme.text}
                >
                  <Show when={expanded() && file.patch.trim().length > 0}>
                    <Diff diff={file.patch} filePath={file.filePath} />
                  </Show>
                  <text fg={theme.textMuted} onMouseUp={() => setExpanded((value) => !value)}>
                    {expanded() ? "Click to collapse" : "… click to view diff"}
                  </text>
                  <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
                </FileToolResult>
              </box>
            )
          }}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={INLINE_TOOL_ICON}
          pending="Preparing patch…"
          failure="Patch failed"
          complete={false}
          part={props.part}
        >
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon={INLINE_TOOL_ICON}
          pending="Updating todos…"
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos…
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon={INLINE_TOOL_ICON} pending="Asking questions…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool
      icon={INLINE_TOOL_ICON}
      pending="Loading skill…"
      complete={stringValue(props.input.name)}
      part={props.part}
    >
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

// The diff is what an edit row is for, so it shows inline like Claude Code and
// Codex do; only a diff too long to scan stays behind a click.
const INLINE_DIFF_LINES = 80

function diffFitsInline(diff: string) {
  return diff.split("\n").length <= INLINE_DIFF_LINES
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || patch === undefined || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
