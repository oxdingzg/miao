import { createMemo, Show } from "solid-js"
import type { PendingPrompt } from "../../context/pending-prompts"
import { useTheme } from "../../context/theme"
import { useSecond } from "../../component/spinner"
import { Locale } from "../../util/locale"

export function PromptStatus(props: { prompt: PendingPrompt }) {
  const theme = useTheme()
  // A steer is promoted at a turn boundary, so a turn running a long tool
  // bounds the wait rather than the prompt itself. A static "waiting" line
  // reads as progress; the clock is what lets the user tell waiting from stuck.
  const seconds = useSecond()
  const waited = createMemo(() => {
    seconds()
    const elapsed = Math.max(0, Date.now() - props.prompt.info.time.created)
    return elapsed >= 1000 ? ` · ${Locale.duration(elapsed)}` : ""
  })
  return (
    <box paddingTop={1}>
      <text fg={props.prompt.state === "failed" ? theme.theme.error : theme.theme.textMuted}>
        {props.prompt.state === "sending"
          ? "SENDING · awaiting receipt"
          : props.prompt.state === "failed"
            ? "SEND FAILED · use prompt history to retry"
            : props.prompt.delivery === "queue"
              ? `QUEUED · waiting until the session is idle${waited()}`
              : `RECEIVED · waiting for the next safe turn${waited()}`}
      </text>
      <Show when={props.prompt.error}>
        <text fg={theme.theme.error}>{props.prompt.error}</text>
      </Show>
    </box>
  )
}
