import { Show } from "solid-js"
import { useTheme } from "../../context/theme"

/**
 * The composer's standing state, on the line under the input box: the
 * permission mode, background work that outlives the current turn, and the next
 * escape action. The line above the box reports what the turn is doing; this
 * one reports what the next keypress does, so neither has to widen when the
 * other changes. It always occupies one line so toggling a mode never moves the
 * composer.
 */
export function SessionPromptHint(props: {
  permissionMode: "auto" | "normal"
  runningJobs: number
  busy: boolean
  waitingPrompts: number
}) {
  const { theme } = useTheme()
  return (
    <box height={1} flexDirection="row" gap={1} paddingLeft={2} flexGrow={1} minWidth={0} flexShrink={0} overflow="hidden">
      <text wrapMode="none" flexShrink={0} fg={props.permissionMode === "auto" ? theme.warning : theme.textMuted}>
        {props.permissionMode === "auto" ? "auto-approve on" : "auto-approve off"}
      </text>
      <Show when={props.runningJobs > 0}>
        <text wrapMode="none" flexShrink={0} fg={theme.textMuted}>
          · {props.runningJobs} background {props.runningJobs === 1 ? "job" : "jobs"} running
        </text>
      </Show>
      <Show when={props.busy}>
        <text wrapMode="none" flexShrink={0}>
          · esc <span style={{ fg: theme.textMuted }}>{props.waitingPrompts > 0 ? "remove prompt" : "interrupt"}</span>
        </text>
      </Show>
    </box>
  )
}
