import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Flag } from "@miao/core/flag/flag"
import { Spinner } from "../../component/spinner"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { waitingForResponse, watchSessionStatus } from "../../context/session-status"
import { Locale } from "../../util/locale"

export function SessionActivity(props: { sessionID: string }) {
  const sync = useSync()
  const [elapsed, setElapsed] = createSignal(0)
  const waiting = createMemo(() => {
    if (!Flag.MIAO_TUI_V2) return false
    const message = sync.data.message[props.sessionID]?.at(-1)
    return waitingForResponse({
      busy: sync.data.session_status[props.sessionID]?.type === "busy",
      blocked:
        (sync.data.permission[props.sessionID]?.length ?? 0) > 0 ||
        (sync.data.question[props.sessionID]?.length ?? 0) > 0,
      message,
      parts: message ? (sync.data.part[message.id] ?? []) : [],
    })
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

  return <SessionWaiting waiting={waiting()} elapsed={elapsed()} />
}

export function SessionWaiting(props: { waiting: boolean; elapsed: number }) {
  const { theme } = useTheme()
  return (
    <Show when={props.waiting}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <Spinner color={theme.textMuted}>
          Waiting for model response · {Locale.duration(props.elapsed)}
          {props.elapsed >= 30000 ? " · no readable output yet; esc interrupt" : ""}
        </Spinner>
      </box>
    </Show>
  )
}
