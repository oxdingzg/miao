import type { Accessor } from "solid-js"
import { createMemo, Show } from "solid-js"
import { Spinner, useSecond } from "../../component/spinner"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { waitingForResponse, statusPhase, type SessionPhase } from "../../context/session-status"
import { Locale } from "../../util/locale"
import { toolDisplay } from "../../util/tool-display"
import type {
  AssistantContent,
  SessionMessage,
  SessionStatus,
  TranscriptAssistantMessage,
  TranscriptMessage,
  TranscriptReasoningPart,
  TranscriptToolPart,
} from "@miao/schema/view-models"
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
  // V2 file tools name their target `path` where the labels read `filePath`.
  const value = part.state.input[key] ?? (key === "filePath" ? part.state.input.path : undefined)
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
export function lastOutputAt(parts: ReadonlyArray<AssistantContent>, fallback: number | null | undefined) {
  const times = parts.flatMap((part) => {
    if (part.type === "tool") {
      if (part.state.status === "pending") return []
      return [part.time?.ran ?? part.time?.created].filter((value): value is number => value !== undefined && value !== null)
    }
    if (part.type === "text") return []
    if (part.type === "reasoning") {
      const time = part.time?.completed ?? part.time?.created
      return time === undefined || time === null ? [] : [time]
    }
    return []
  })
  if (times.length === 0) return fallback ?? undefined
  const latest = Math.max(...times)
  return fallback === undefined || fallback === null ? latest : Math.max(latest, fallback)
}

export function SessionActivity(props: { sessionID: string }) {
  const sync = useSync()
  const status = createMemo(() => sync.data.session_status[props.sessionID])
  const compaction = createMemo(() => sync.data.session_compaction[props.sessionID])
  const busy = createMemo(() => status()?.type === "busy")
  const phase = createMemo(() => (compaction() ? ("compacting" as const) : statusPhase(status())))
  // Slice progress rides the drain status, so the count is live for the whole
  // staged run rather than only after it settles.
  const progress = createMemo(() => {
    const current = status()
    return current?.type === "busy" ? current.progress : undefined
  })
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
    if (compaction() || !busy() || blocked()) return undefined
    return turnActivity({ parts: turnParts(), working: !waiting() })
  })
  const turnStartedAt = createMemo(() => messages().findLast((entry) => entry.type === "user")?.time.created)
  const lastOutput = createMemo(() => lastOutputAt(turnParts(), turnStartedAt()))
  const active = createMemo(() => (busy() || !!compaction()) && !blocked())
  // The timestamp the elapsed timer counts from: the phase's own start so the
  // timer is TTFT for `requesting`, not the time since the last streamed
  // output. A start that is not epoch millis prints "NaNd NaNh", so undefined
  // means no timer rather than a broken one; the shared one-second clock that
  // re-reads this lives in SessionActiveWaiting, mounted only while active.
  const elapsedBase = createMemo(() => {
    if (!active()) return undefined
    const summary = compaction()
    if (summary) return summary.since
    const current = status()
    const since = current?.type === "busy" ? current.since : undefined
    return since ?? lastOutput()
  })

  const error = createMemo(() => {
    if (compaction()) return undefined
    const status = sync.data.session_status[props.sessionID]
    return status?.type === "retry" ? status.message : sync.data.session_error[props.sessionID]
  })
  // Background work the turn left behind: child sessions still executing. The
  // transcript already lists their tool blocks, but a settled turn that is
  // still delegating must not read as finished.
  const background = createMemo(
    () =>
      sync.data.session.filter((session) => {
        if (session.parentID !== props.sessionID) return false
        const status = sync.data.session_status[session.id]
        return status !== undefined && status.type !== "idle"
      }).length,
  )
  // Replaced by the live line while the turn runs; a settled turn keeps one
  // line naming its duration and completion time.
  const summary = createMemo(() =>
    busy() || compaction() || blocked()
      ? undefined
      : turnSummary({ messages: messages(), background: background() }),
  )
  // The esc hint names the next esc action, matching the prompt footer: one
  // esc cancels the newest waiting prompt, and only an empty queue interrupts.
  const waitingCount = createMemo(() => sync.prompt.waiting(props.sessionID).length)
  const esc = createMemo(() => "interrupt")
  return (
    <Show
      when={error()}
      fallback={
        <Show
          when={active()}
          fallback={
            <>
              <SessionWaiting
                waiting={waiting()}
                elapsed={0}
                activity={activity()}
                phase={phase()}
                progress={progress()}
                esc={esc()}
              />
              <SessionSummary text={summary()} />
            </>
          }
        >
          <SessionActiveWaiting
            waiting={waiting()}
            activity={activity()}
            phase={phase()}
            progress={progress()}
            base={elapsedBase}
            esc={esc()}
          />
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
  progress?: { readonly stage: number; readonly stages: number }
  base: Accessor<number | undefined>
  esc?: string
}) {
  const seconds = useSecond()
  const elapsed = createMemo(() => {
    seconds()
    const value = Date.now() - (props.base() ?? Number.NaN)
    return Number.isFinite(value) ? Math.max(0, value) : 0
  })
  return (
    <SessionWaiting
      waiting={props.waiting}
      elapsed={elapsed()}
      activity={props.activity}
      phase={props.phase}
      progress={props.progress}
      esc={props.esc}
    />
  )
}

// Claude Code closes a turn with one settled line. The per-message footer
// describes a single step, so the turn's own span — from the prompt that opened
// it to the last completed step — has no other place to appear.
export function turnSummary(input: {
  messages: ReadonlyArray<SessionMessage>
  /** Child sessions still executing when the turn settled. */
  background?: number
}): string | undefined {
  const start = input.messages.findLastIndex((message) => message.type === "user")
  if (start < 0) return undefined
  const opened = input.messages[start].time.created
  if (opened === null) return undefined
  const tail = input.messages
    .slice(start + 1)
    .findLast((message): message is TranscriptAssistantMessage => message.type === "assistant")
  // A turn without a completed step is still running, or was interrupted
  // before it could settle; neither has a finished span to report.
  if (!tail || tail.time.completed === undefined) return undefined
  // A failed tail renders its own error block. Summarizing it as work would
  // read as success.
  if (tail.error !== undefined && tail.error.interrupted !== true) return undefined
  const duration = Locale.duration(Math.max(0, tail.time.completed - opened))
  const verb = tail.error?.interrupted === true ? `Stopped after ${duration}` : `Worked for ${duration}`
  const running = input.background ?? 0
  const background = running > 0 ? ` · ${running} subagent${running === 1 ? "" : "s"} still running` : ""
  return `${verb} · done ${Locale.todayTimeOrDateTime(tail.time.completed)}${background}`
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

// Name one tool call the way the live turn line does: present tense while it
// runs, past tense once it settles. `undefined` for tools without a live name
// (and for calls that never ran), so callers can fall back to counting.
export function toolActivity(part: TranscriptToolPart): string | undefined {
  const group = TOOL_GROUPS.find((candidate) => candidate.displays.includes(toolDisplay(part.name)))
  const detail = group?.live(part)
  if (!group || !detail) return undefined
  return `${part.state.status === "running" ? group.verb[0] : group.verb[1]} ${detail}`
}

// The inline subagent block's live tail: up to `limit` named tool calls from
// the child transcript, oldest first, so the newest line sits directly under
// the running header. Unnamed tools drop out instead of rendering a bare count.
export function subagentActivity(messages: ReadonlyArray<TranscriptMessage>, limit = 3): string[] {
  const named = messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => {
          const text = part.type === "tool" ? toolActivity(part) : undefined
          return text ? [text] : []
        })
      : [],
  )
  return named.slice(-limit)
}

// A subagent row is live while its own tool call runs; a background task's call
// completes immediately, so the child's execution status keeps the row live.
// An errored call never spins, whatever the child reports.
export function subagentRunning(
  status: TranscriptToolPart["state"]["status"],
  background: boolean | undefined,
  child: SessionStatus | undefined,
) {
  if (status === "running") return true
  return status === "completed" && background === true && child !== undefined && child.type !== "idle"
}

// One-line preview of a finished subagent's report for its collapsed row.
export function subagentResult(output: string | undefined) {
  const line = output?.split("\n").find((candidate) => candidate.trim().length > 0)
  if (line === undefined) return undefined
  const trimmed = line.trim()
  return trimmed.length > LIVE_LIMIT ? `${trimmed.slice(0, LIVE_LIMIT)}…` : trimmed
}

// The block `session.subagent.toggle` acts on: the newest running subagent
// beats an older settled one, and the newest settled block is the fallback.
export function latestSubagentPartID(messages: ReadonlyArray<TranscriptMessage>): string | undefined {
  let settled: string | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    const content = message.content
    for (let offset = content.length - 1; offset >= 0; offset -= 1) {
      const part = content[offset]
      if (part.type !== "tool" || part.name !== "task") continue
      if (part.state.status === "running") return part.id
      settled ??= part.id
    }
  }
  return settled
}

// Concurrent subagents render one block each with the running ones on top.
// Only sibling tool parts move, and only among themselves, so prose, reasoning,
// and ordinary tools keep their place in the timeline.
export function orderTaskBlocks(content: ReadonlyArray<AssistantContent>): AssistantContent[] {
  const runningTask = (part: AssistantContent) =>
    part.type === "tool" && part.name === "task" && part.state.status === "running"
  const out: AssistantContent[] = []
  let siblings: AssistantContent[] = []
  const flush = () => {
    if (siblings.length === 0) return
    out.push(...siblings.filter(runningTask), ...siblings.filter((part) => !runningTask(part)))
    siblings = []
  }
  for (const part of content) {
    if (part.type !== "tool") {
      flush()
      out.push(part)
      continue
    }
    siblings.push(part)
  }
  flush()
  return out
}

export function SessionWaiting(props: {
  waiting: boolean
  elapsed: number
  activity?: string
  phase?: SessionPhase
  progress?: { readonly stage: number; readonly stages: number }
  esc?: string
}) {
  const { theme } = useTheme()
  // Claude Code keeps the elapsed time on the live status line whether the turn
  // is still reading its first token or already running tools.
  const text = createMemo(() => {
    if (props.phase === "compacting")
      return waitingText(props.phase, props.elapsed, props.esc ?? "interrupt", props.progress)
    if (props.activity) {
      return props.elapsed > 0 ? `${props.activity} · ${Locale.duration(props.elapsed)}` : props.activity
    }
    if (!props.waiting) return undefined
    return waitingText(props.phase, props.elapsed, props.esc ?? "interrupt", props.progress)
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

// The settled counterpart of the live status line, in the same slot and at the
// same size so the turn's ending replaces its progress rather than appearing
// somewhere else.
function SessionSummary(props: { text?: string }) {
  const { theme } = useTheme()
  return (
    <Show when={props.text}>
      {(text) => (
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <text fg={theme.textMuted}>● {text()}</text>
        </box>
      )}
    </Show>
  )
}

// Name what is actually being waited on. `requesting` is a dispatched request
// awaiting the first token (TTFT); `preparing` and `queued` have not reached the
// provider yet, which is the distinction the old single label could not make.
function waitingText(
  phase: SessionPhase | undefined,
  elapsed: number,
  esc: string,
  progress?: { readonly stage: number; readonly stages: number },
) {
  // A staged compaction summarizes in slices, so say how many: an indeterminate
  // wait is what made a long compaction look like a hang.
  const slices = progress !== undefined && progress.stages > 0 ? ` · ${progress.stage}/${progress.stages} slices` : ""
  const label =
    phase === "compacting"
      ? `Compacting context${slices}`
      : phase === "queued"
        ? "Queued · waiting for a free slot"
        : phase === "preparing"
          ? "Preparing request"
          : phase === "streaming"
            ? "Receiving model response"
            : phase === "retrying"
              ? "Retrying"
              : "Waiting for model response"
  const suffix =
    phase === "compacting"
      ? elapsed >= 30000
        ? ` · still waiting for summary; esc ${esc}`
        : " · making room to continue"
      : elapsed >= 30000
        ? ` · no readable output yet; esc ${esc}`
        : ""
  return `${label} · ${Locale.duration(elapsed)}${suffix}`
}
