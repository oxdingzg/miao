import type { Accessor } from "solid-js"
import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { Spinner, useSecond } from "../../component/spinner"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { waitingForResponse, watchSessionStatus, statusPhase, type SessionPhase } from "../../context/session-status"
import { Locale } from "../../util/locale"
import { toolDisplay } from "../../util/tool-display"
import type { AssistantContent, TranscriptReasoningPart, TranscriptToolPart } from "@miao/schema/view-models"
import { ProviderFailure } from "./provider-failure"

// Claude Code reports a turn as `[running|ran] N shell commands` on one live
// status line. miao's V2 core emits one assistant message per provider turn, so
// counting per message would always report a single command; accumulate across
// every step of the current turn instead.
// The live line names the work in flight rather than only counting it, which is
// what makes "running 1 shell command" readable as a command. A count is a last
// resort for the cases a name cannot cover: a tool whose input we cannot read.
const LIVE_LIMIT = 60

const toolInput = (part: TranscriptToolPart, key: string) => {
  if (part.state.status !== "running" && part.state.status !== "completed") return undefined
  const value = part.state.input[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const shorten = (value: string | undefined) => {
  const line = value?.split("\n")[0].trim()
  if (!line) return undefined
  return line.length > LIVE_LIMIT ? `${line.slice(0, LIVE_LIMIT)}…` : line
}

const TOOL_GROUPS = [
  {
    displays: ["bash"],
    verb: ["running", "ran"],
    noun: "shell command",
    plural: "shell commands",
    live: (part: TranscriptToolPart) => shorten(toolInput(part, "command")),
  },
  {
    displays: ["read"],
    verb: ["reading", "read"],
    noun: "file",
    plural: "files",
    live: (part: TranscriptToolPart) => shorten(toolInput(part, "filePath")),
  },
  {
    displays: ["grep", "glob", "websearch"],
    verb: ["searching for", "searched for"],
    noun: "pattern",
    plural: "patterns",
    live: (part: TranscriptToolPart) => shorten(toolInput(part, "pattern") ?? toolInput(part, "query")),
  },
  {
    displays: ["edit", "write", "apply_patch"],
    verb: ["editing", "edited"],
    noun: "file",
    plural: "files",
    live: (part: TranscriptToolPart) => shorten(toolInput(part, "filePath")),
  },
  {
    displays: ["task"],
    verb: ["delegating to", "delegated to"],
    noun: "subagent",
    plural: "subagents",
    live: (part: TranscriptToolPart) => shorten(toolInput(part, "description")),
  },
]

// Naming one tool is only honest while exactly one is in flight; with several
// running, one name would hide the others.
function runningTool(parts: ReadonlyArray<AssistantContent>) {
  const running = parts.filter(
    (part): part is TranscriptToolPart => part.type === "tool" && part.state.status === "running",
  )
  if (running.length !== 1) return undefined
  const group = TOOL_GROUPS.find((group) => group.displays.includes(toolDisplay(running[0].name)))
  if (!group) return undefined
  const detail = group.live(running[0])
  return detail ? { group, text: `${group.verb[0]} ${detail}` } : undefined
}

// The live timer answers "how long since the last output", not "how long has
// this turn run": a tool that has produced nothing for twelve minutes must not
// read as a healthy twelve-minute turn. Each part records when it last changed,
// so the newest stamp is the moment output stopped. A turn with no output yet
// falls back to the prompt that opened it.
export function lastOutputAt(parts: ReadonlyArray<AssistantContent>, fallback: number | undefined) {
  const times = parts.flatMap((part) => {
    if (part.type === "tool") {
      if (part.state.status === "pending") return []
      return [part.time?.ran ?? part.time?.created].filter((value): value is number => value !== undefined)
    }
    if (part.type === "text") return []
    if (part.type === "reasoning") {
      const time = part.time?.completed ?? part.time?.created
      return time === undefined ? [] : [time]
    }
    return []
  })
  if (times.length === 0) return fallback
  const latest = Math.max(...times)
  return fallback === undefined ? latest : Math.max(latest, fallback)
}

export function SessionActivity(props: { sessionID: string }) {
  const sync = useSync()
  const status = createMemo(() => sync.data.session_status[props.sessionID])
  const busy = createMemo(() => status()?.type === "busy")
  const phase = createMemo(() => statusPhase(status()))
  const blocked = createMemo(
    () =>
      (sync.data.permission[props.sessionID]?.length ?? 0) > 0 ||
      (sync.data.question[props.sessionID]?.length ?? 0) > 0,
  )
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const message = createMemo(() => messages().at(-1))
  const content = createMemo(() => {
    const current = message()
    return current?.type === "assistant" ? current.content : []
  })
  const waiting = createMemo(() => {
    return waitingForResponse({ busy: busy(), blocked: blocked(), message: message(), content: content() })
  })
  const turnParts = createMemo(() => {
    const list = messages()
    const start = list.findLastIndex((entry) => entry.type === "user")
    return list.slice(start + 1).flatMap((entry) => (entry.type === "assistant" ? entry.content : []))
  })
  // `working` mirrors Claude Code's live flag: the current step is still
  // streaming, so the summary uses present tense and flips to past between steps.
  const activity = createMemo(() => {
    if (!busy() || blocked()) return undefined
    return turnActivity({ parts: turnParts(), working: !waiting() })
  })
  const turnStartedAt = createMemo(() => messages().findLast((entry) => entry.type === "user")?.time.created)
  const lastOutput = createMemo(() => lastOutputAt(turnParts(), turnStartedAt()))
  const active = createMemo(() => busy() && !blocked())
  // The timestamp the elapsed timer counts from: the phase's own start so the
  // timer is TTFT for `requesting`, not the time since the last streamed
  // output. A start that is not epoch millis prints "NaNd NaNh", so undefined
  // means no timer rather than a broken one; the shared one-second clock that
  // re-reads this lives in SessionActiveWaiting, mounted only while active.
  const elapsedBase = createMemo(() => {
    if (!active()) return undefined
    const current = status()
    const since = current?.type === "busy" ? current.since : undefined
    return since ?? lastOutput()
  })

  createEffect(() => {
    const sessionID = props.sessionID
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

  const error = createMemo(() => {
    const status = sync.data.session_status[props.sessionID]
    return status?.type === "retry" ? status.message : sync.data.session_error[props.sessionID]
  })
  return (
    <Show
      when={error()}
      fallback={
        <Show
          when={active()}
          fallback={<SessionWaiting waiting={waiting()} elapsed={0} activity={activity()} phase={phase()} />}
        >
          <SessionActiveWaiting waiting={waiting()} activity={activity()} phase={phase()} base={elapsedBase} />
        </Show>
      }
    >
      {(message) => <ProviderFailure message={message()} />}
    </Show>
  )
}

/**
 * The waiting line for an active turn. This node owns the shared one-second
 * clock subscription so an idle session route holds no timer: the clock stops
 * when the last active turn unmounts this node.
 */
function SessionActiveWaiting(props: {
  waiting: boolean
  activity?: string
  phase?: SessionPhase
  base: Accessor<number | undefined>
}) {
  const seconds = useSecond()
  const elapsed = createMemo(() => {
    seconds()
    const value = Date.now() - (props.base() ?? Number.NaN)
    return Number.isFinite(value) ? Math.max(0, value) : 0
  })
  return <SessionWaiting waiting={props.waiting} elapsed={elapsed()} activity={props.activity} phase={props.phase} />
}

export function turnActivity(input: { parts: AssistantContent[]; working: boolean }) {
  // A running step is part of the turn's work, so count it in the live summary.
  // Completed steps stay counted once the turn settles into past tense.
  const tools = input.parts.filter((part): part is TranscriptToolPart => {
    if (part.type !== "tool") return false
    if (part.state.status === "completed") return true
    return input.working && part.state.status === "running"
  })
  const reasoning = input.parts.filter((part): part is TranscriptReasoningPart => part.type === "reasoning")
  const thinking = reasoning.some((part) => part.time?.completed === undefined && part.text.trim().length > 0)
  const thought = reasoning.reduce((total, part) => {
    const completed = part.time?.completed
    return completed === undefined ? total : total + Math.max(0, completed - (part.time?.created ?? 0))
  }, 0)
  const live = input.working ? runningTool(input.parts) : undefined
  const segments = [
    thinking ? "Thinking" : thought > 0 ? `Thought for ${Locale.duration(thought)}` : undefined,
    live?.text,
    ...TOOL_GROUPS.filter((group) => group !== live?.group).map((group) => {
      const count = tools.filter((part) => group.displays.includes(toolDisplay(part.name))).length
      if (count === 0) return undefined
      return `${input.working ? group.verb[0] : group.verb[1]} ${count} ${count === 1 ? group.noun : group.plural}`
    }),
  ].filter((segment): segment is string => segment !== undefined)
  return segments.length > 0 ? segments.join(", ") : undefined
}

export function SessionWaiting(props: { waiting: boolean; elapsed: number; activity?: string; phase?: SessionPhase }) {
  const { theme } = useTheme()
  // Claude Code keeps the elapsed time on the live status line whether the turn
  // is still reading its first token or already running tools.
  const text = createMemo(() => {
    if (props.activity) {
      return props.elapsed > 0 ? `${props.activity} · ${Locale.duration(props.elapsed)}` : props.activity
    }
    if (!props.waiting) return undefined
    return waitingText(props.phase, props.elapsed)
  })
  return (
    <Show when={text()}>
      {(value) => (
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <Spinner color={theme.textMuted}>{value()}</Spinner>
        </box>
      )}
    </Show>
  )
}

// Name what is actually being waited on. `requesting` is a dispatched request
// awaiting the first token (TTFT); `preparing` and `queued` have not reached the
// provider yet, which is the distinction the old single label could not make.
function waitingText(phase: SessionPhase | undefined, elapsed: number) {
  const label =
    phase === "queued"
      ? "Queued · waiting for a free slot"
      : phase === "preparing"
        ? "Preparing request"
        : phase === "streaming"
          ? "Receiving model response"
          : phase === "retrying"
            ? "Retrying"
            : "Waiting for model response"
  const suffix = elapsed >= 30000 ? " · no readable output yet; esc interrupt" : ""
  return `${label} · ${Locale.duration(elapsed)}${suffix}`
}
