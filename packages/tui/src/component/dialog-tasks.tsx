import { createMemo } from "solid-js"
import { useSessionState } from "../context/session-state"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { taskRows } from "../util/session-timers"

/**
 * Everything the turn left running in the background — jobs, wakeups, and
 * queued notifications — in one place. The live timer row under the composer
 * trims to a few lines; this is the "what is still going on?" view a long turn
 * needs, so a reader is never guessing whether work outlives the turn. Opened
 * from `/tasks` (aliases `/jobs`, `/ps`).
 */
export function DialogTasks(props: { sessionID: string }) {
  const dialog = useDialog()
  const state = useSessionState()
  const { theme } = useTheme()
  const options = createMemo(() => {
    const snapshot = state.data.sessionID === props.sessionID ? state.data.snapshot : undefined
    if (!snapshot) return []
    // Job timestamps are epoch millis; date them against the wall clock so a
    // running job keeps counting while the dialog stays open.
    return taskRows(snapshot.activity, Date.now()).map((row) => ({
      title: row.title,
      value: row.id,
      description: row.detail,
    }))
  })
  return (
    <DialogSelect
      title={`Background · ${options().length}`}
      options={options()}
      onSelect={() => dialog.clear()}
      emptyView={<text fg={theme.textMuted}>Nothing running in the background</text>}
    />
  )
}
