import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Flag } from "@miao/core/flag/flag"
import { Spinner } from "../../component/spinner"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { waitingForResponse, watchSessionStatus } from "../../context/session-status"
import { Locale } from "../../util/locale"
import { toolDisplay } from "../../util/tool-display"
import type { Part, ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"

// Claude Code reports a turn as `[running|ran] N shell commands` on one live
// status line. miao's V2 core emits one assistant message per provider turn, so
// counting per message would always report a single command; accumulate across
// every step of the current turn instead.
const TOOL_GROUPS = [
  { displays: ["bash"], verb: ["running", "ran"], noun: "shell command", plural: "shell commands" },
  { displays: ["read"], verb: ["reading", "read"], noun: "file", plural: "files" },
  {
    displays: ["grep", "glob", "websearch"],
    verb: ["searching for", "searched for"],
    noun: "pattern",
    plural: "patterns",
  },
  { displays: ["edit", "write", "apply_patch"], verb: ["editing", "edited"], noun: "file", plural: "files" },
]

export function SessionActivity(props: { sessionID: string }) {
  const sync = useSync()
  const [elapsed, setElapsed] = createSignal(0)
  const busy = createMemo(() => sync.data.session_status[props.sessionID]?.type === "busy")
  const blocked = createMemo(
    () =>
      (sync.data.permission[props.sessionID]?.length ?? 0) > 0 ||
      (sync.data.question[props.sessionID]?.length ?? 0) > 0,
  )
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const message = createMemo(() => messages().at(-1))
  const parts = createMemo(() => {
    const current = message()
    return current ? (sync.data.part[current.id] ?? []) : []
  })
  const waiting = createMemo(() => {
    if (!Flag.MIAO_TUI_V2) return false
    return waitingForResponse({ busy: busy(), blocked: blocked(), message: message(), parts: parts() })
  })
  const turnParts = createMemo(() => {
    const list = messages()
    const start = list.findLastIndex((entry) => entry.role === "user")
    return list.slice(start + 1).flatMap((entry) => sync.data.part[entry.id] ?? [])
  })
  // `working` mirrors Claude Code's live flag: the current step is still
  // streaming, so the summary uses present tense and flips to past between steps.
  const activity = createMemo(() => {
    if (!Flag.MIAO_TUI_V2 || !busy() || blocked()) return undefined
    return turnActivity({ parts: turnParts(), working: !waiting() })
  })

  createEffect(() => {
    const sessionID = props.sessionID
    if (!Flag.MIAO_TUI_V2) return
    const abort = new AbortController()
    const stop = watchSessionStatus({
      read: () => sync.session.syncStatus(sessionID, abort.signal),
      onError: (error) => console.error("Failed to read session execution status", error),
    })
    onCleanup(() => {
      stop()
      abort.abort()
    })
  })

  createEffect(() => {
    if (!props.sessionID || !waiting()) return
    const start = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - start), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return <SessionWaiting waiting={waiting()} elapsed={elapsed()} activity={activity()} />
}

export function turnActivity(input: { parts: Part[]; working: boolean }) {
  const tools = input.parts.filter(
    (part): part is ToolPart => part.type === "tool" && part.state.status === "completed",
  )
  const reasoning = input.parts.filter((part): part is ReasoningPart => part.type === "reasoning")
  const thinking = reasoning.some((part) => part.time.end === undefined && part.text.trim().length > 0)
  const thought = reasoning.reduce((total, part) => {
    const end = part.time.end
    return end === undefined ? total : total + Math.max(0, end - part.time.start)
  }, 0)
  const segments = [
    thinking ? "Thinking" : thought > 0 ? `Thought for ${Locale.duration(thought)}` : undefined,
    ...TOOL_GROUPS.map((group) => {
      const count = tools.filter((part) => group.displays.includes(toolDisplay(part.tool))).length
      if (count === 0) return undefined
      return `${input.working ? group.verb[0] : group.verb[1]} ${count} ${count === 1 ? group.noun : group.plural}`
    }),
  ].filter((segment): segment is string => segment !== undefined)
  return segments.length > 0 ? segments.join(", ") : undefined
}

export function SessionWaiting(props: { waiting: boolean; elapsed: number; activity?: string }) {
  const { theme } = useTheme()
  return (
    <Show when={props.activity ?? (props.waiting ? waitingText(props.elapsed) : undefined)}>
      {(text) => (
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <Spinner color={theme.textMuted}>{text()}</Spinner>
        </box>
      )}
    </Show>
  )
}

function waitingText(elapsed: number) {
  const suffix = elapsed >= 30000 ? " · no readable output yet; esc interrupt" : ""
  return `Waiting for model response · ${Locale.duration(elapsed)}${suffix}`
}
