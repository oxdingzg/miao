import type { SessionsActivityOutput } from "@miao/client"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useSecond } from "../../component/spinner"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { watchSessionStatus } from "../../context/session-status"
import { sessionTimerRows } from "../../util/session-timers"

export function SessionTimers(props: { sessionID: string }) {
  const sdk = useSDK()
  const [snapshot, setSnapshot] = createSignal<{ activity: SessionsActivityOutput; receivedAt: number }>()
  const [stale, setStale] = createSignal<number>()

  createEffect(() => {
    const sessionID = props.sessionID
    const abort = new AbortController()
    setSnapshot(undefined)
    setStale(undefined)
    const stop = watchSessionStatus({
      interval: 2000,
      idleInterval: 5000,
      read: async () => {
        const activity = await sdk.api.sessions.activity({ sessionID }, { signal: abort.signal })
        if (abort.signal.aborted) return "idle"
        setSnapshot({ activity, receivedAt: performance.now() })
        setStale(undefined)
        return sessionTimerRows(activity, activity.observedAt).some((row) => row.id !== "unknown") ? "busy" : "idle"
      },
      onError: () => setStale((current) => current ?? performance.now()),
    })
    onCleanup(() => {
      stop()
      abort.abort()
    })
  })

  return (
    <Show when={snapshot() && sessionTimerRows(snapshot()!.activity, snapshot()!.activity.observedAt).length > 0}>
      <SessionTimerDisplay snapshot={snapshot()!} stale={stale()} />
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
