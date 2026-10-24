import { Model } from "../util/model"
import { createMemo, For } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTuiPaths } from "../context/runtime"
import { useDialog } from "../ui/dialog"
import { abbreviateHome } from "../runtime"
import { remainingContext } from "../util/context-usage"
import { statusSegments } from "../util/status-line"
import { Locale } from "../util/locale"
import { DialogModel } from "./dialog-model"

export function StatusLine(props: { sessionID?: string; directory?: string; newWorkspace?: boolean }) {
  const local = useLocal()
  const sync = useSync()
  const paths = useTuiPaths()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const { theme } = useTheme()
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const context = createMemo(() => {
    const selected = local.model.parsed()
    const model = Model.get(sync.data.provider, selected.providerID, selected.modelID)
    return remainingContext(
      props.sessionID ? (sync.data.message[props.sessionID] ?? []) : [],
      model
        ? { ...(selected.wireModel ?? { providerID: model.providerID, id: model.id }), window: model.limit.context }
        : undefined,
    )
  })
  const contextColor = createMemo(() => {
    const remaining = context().remaining
    if (remaining === undefined) return theme.textMuted
    if (remaining <= 10) return theme.error
    if (remaining <= 20) return theme.warning
    return theme.textMuted
  })
  const children = createMemo(() =>
    props.sessionID ? sync.data.session.filter((item) => item.parentID === props.sessionID) : [],
  )
  const active = createMemo(
    () =>
      children().filter((item) => {
        const status = sync.data.session_status[item.id]
        return status !== undefined && status.type !== "idle"
      }).length,
  )
  const segments = createMemo(() => {
    const directory = props.directory ?? session()?.location.directory ?? (sync.path.directory || paths.cwd)
    return statusSegments(
      {
        model: local.model.parsed().model,
        context: context().label,
        directory: props.newWorkspace ? "New workspace" : abbreviateHome(directory, paths.home),
        branch: !props.newWorkspace && directory === sync.path.directory ? sync.data.vcs?.branch : undefined,
        agent: [
          Locale.titlecase(session()?.agent ?? local.agent.current()?.name ?? "Agent"),
          children().length ? `${active() > 0 ? `${active()} active / ` : ""}${children().length} agents` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      },
      Math.max(1, dimensions().width - 4),
    )
  })
  return (
    <box
      width="100%"
      height={1}
      marginBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      overflow="hidden"
    >
      <For each={segments()}>
        {(item, index) => (
          <>
            {index() > 0 && <text fg={theme.textMuted}> · </text>}
            <text
              wrapMode="none"
              fg={item.key === "model" ? theme.text : item.key === "context" ? contextColor() : theme.textMuted}
              onMouseUp={() => {
                if (item.key === "model") dialog.replace(() => <DialogModel />)
              }}
            >
              {item.text}
            </text>
          </>
        )}
      </For>
    </box>
  )
}
