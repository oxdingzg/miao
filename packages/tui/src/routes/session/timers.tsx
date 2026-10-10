import type { SessionsActivityOutput } from "@miao/client"
import { createMemo, For, Show } from "solid-js"
import { useSecond } from "../../component/spinner"
import { useSessionState } from "../../context/session-state"
import { useTheme } from "../../context/theme"
import { sessionTimerRows } from "../../util/session-timers"

export function SessionTimers(props: { sessionID: string }) {
  const state = useSessionState()
  const snapshot = createMemo(() => (state.data.sessionID === props.sessionID ? state.data.snapshot : undefined))
  return (
    <Show when={snapshot() && sessionTimerRows(snapshot()!.activity, snapshot()!.activity.observedAt).length > 0}>
      <SessionTimerDisplay snapshot={snapshot()!} stale={state.data.stale} />
    </Show>
  )
}

export function SessionTimerDisplay(props: {
  snapshot: { activity: SessionsActivityOutput; receivedAt: number }
  stale?: number
}) {
  const { theme } = useTheme()
  const second = useSecond()
  const rows = createMemo(() => {
    second()
    // Server epoch plus monotonic client elapsed time avoids clock skew. Freeze
    // on read failure instead of pretending an old job is still making progress.
    const activity = props.snapshot.activity
    return sessionTimerRows(
      activity,
      activity.observedAt + (props.stale ?? performance.now()) - props.snapshot.receivedAt,
    )
  })
  return (
    <box paddingLeft={2} paddingRight={2} flexShrink={0}>
      <For each={rows().slice(0, 3)}>{(row) => <text fg={theme[row.color]}>{row.text}</text>}</For>
      <Show when={rows().length > 3}>
        <text fg={theme.textMuted}>+{rows().length - 3} more background timers</text>
      </Show>
      <Show when={props.stale !== undefined}>
        <text fg={theme.warning}>Status unavailable · timers paused until connection recovers</text>
      </Show>
    </box>
  )
}
