import { Show } from "solid-js"
import type { PendingPrompt } from "../../context/pending-prompts"
import { useTheme } from "../../context/theme"

export function PromptStatus(props: { prompt: PendingPrompt }) {
  const theme = useTheme()
  return (
    <box paddingTop={1}>
      <text fg={props.prompt.state === "failed" ? theme.theme.error : theme.theme.textMuted}>
        {props.prompt.state === "sending"
          ? "SENDING · awaiting receipt"
          : props.prompt.state === "failed"
            ? "SEND FAILED · use prompt history to retry"
            : props.prompt.delivery === "queue"
              ? "QUEUED · waiting until the session is idle"
              : "RECEIVED · waiting for the next safe turn"}
      </text>
      <Show when={props.prompt.error}>
        <text fg={theme.theme.error}>{props.prompt.error}</text>
      </Show>
    </box>
  )
}
