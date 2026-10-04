import { useTheme } from "../../context/theme"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@miao/schema/view-models"

/** Failures before an assistant step still need a visible session-level error. */
export function ProviderFailure(props: { message: string }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text id="provider-error-message" fg={theme.error}>
        {providerErrorText(props.message)}
      </text>
    </box>
  )
}

export function providerErrorText(message: string) {
  if (/^(?:API Error|Error):/.test(message)) return message
  return /^(?:[45]\d\d)\b|\bHTTP [45]\d\d\b/.test(message) ? `API Error: ${message}` : `Error: ${message}`
}

export function ProviderRetryStatus(props: { status: SessionStatus }) {
  const { theme } = useTheme()
  const retry = createMemo(() => (props.status.type === "retry" ? props.status : undefined))
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const next = retry()?.next
    setSeconds(0)
    // Native retry events announce an attempt after its backoff. Only count
    // down when a producer actually supplies a future retry deadline.
    if (!next || next <= Date.now()) return
    const read = () => setSeconds(Math.max(0, Math.ceil((next - Date.now()) / 1000)))
    read()
    const timer = setInterval(() => {
      read()
      if (Date.now() >= next) clearInterval(timer)
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Show when={retry()}>
      {(value) => (
        <text fg={theme.textMuted}>
          {`Retrying${seconds() > 0 ? ` in ${seconds()}s` : ""} · attempt #${value().attempt}`}
        </text>
      )}
    </Show>
  )
}
