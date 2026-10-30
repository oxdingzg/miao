import { useCommandShortcut, useOpencodeKeymap } from "../keymap"
import { Model } from "../util/model"
import { createMemo, For, Show } from "solid-js"
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

/**
 * What the next keypress does: the permission mode, background work that
 * outlives the turn, and the next escape action. It shares the status row with
 * the model and the shortcuts so the composer does not spend a second line on
 * two or three words.
 */
export type StatusHint = {
  permissionMode: "auto" | "normal"
  runningJobs: number
  busy: boolean
  waitingPrompts: number
}

export type StatusHintItem = { text: string; tone: "warning" | "text" | "muted" }

export function statusHintSegments(source: StatusHint): StatusHintItem[] {
  return [
    {
      text: source.permissionMode === "auto" ? "auto-approve on" : "auto-approve off",
      tone: source.permissionMode === "auto" ? "warning" : "muted",
    },
    ...(source.runningJobs > 0
      ? [
          {
            text: `${source.runningJobs} background ${source.runningJobs === 1 ? "job" : "jobs"} running`,
            tone: "muted" as const,
          },
        ]
      : []),
    ...(source.waitingPrompts > 0
      ? [
          {
            text: `queued (${source.waitingPrompts})`,
            tone: "muted" as const,
          },
        ]
      : []),
    ...(source.busy
      ? [{ text: `esc ${source.waitingPrompts > 0 ? "remove prompt" : "interrupt"}`, tone: "text" as const }]
      : []),
  ]
}

export function StatusLine(props: {
  sessionID?: string
  directory?: string
  newWorkspace?: boolean
  hint?: StatusHint
}) {
  const local = useLocal()
  const sync = useSync()
  const paths = useTuiPaths()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const keymap = useOpencodeKeymap()
  const paletteShortcut = useCommandShortcut("command.palette.show")
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
  const hint = createMemo<StatusHintItem[]>(() => (props.hint ? statusHintSegments(props.hint) : []))
  // The hint shares this row, so the model and context must fit in what is left:
  // the separators are three columns and the trailing one joins the two groups.
  const hintWidth = createMemo(() =>
    hint().length === 0
      ? 0
      : hint().reduce((total, item) => total + Bun.stringWidth(item.text), 0) + (hint().length - 1) * 3 + 3,
  )
  const segments = createMemo(() => {
    const directory = props.directory ?? session()?.location.directory ?? (sync.path.directory || paths.cwd)
    return statusSegments(
      {
        model: local.model.parsed().model,
        provider: local.model.parsed().providerID ? local.model.parsed().provider : undefined,
        variant: local.model.variant.current(),
        context: context().label,
        directory: props.newWorkspace ? "New workspace" : abbreviateHome(directory, paths.home),
        shortcut: paletteShortcut() ? `${paletteShortcut()} commands` : undefined,
        branch: !props.newWorkspace && directory === sync.path.directory ? sync.data.vcs?.branch : undefined,
        agent: [
          Locale.titlecase(session()?.agent ?? local.agent.current()?.name ?? "Agent"),
          children().length ? `${active() > 0 ? `${active()} active / ` : ""}${children().length} agents` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      },
      Math.max(1, dimensions().width - 4 - hintWidth()),
    )
  })
  return (
    <box
      width="100%"
      height={1}
      marginBottom={props.sessionID ? 0 : 1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      overflow="hidden"
    >
      <Show when={hint().length > 0}>
        <For each={hint()}>
          {(item, index) => (
            <>
              {index() > 0 && <text fg={theme.textMuted}> · </text>}
              <text
                wrapMode="none"
                fg={item.tone === "warning" ? theme.warning : item.tone === "text" ? theme.text : theme.textMuted}
              >
                {item.text}
              </text>
            </>
          )}
        </For>
        <text fg={theme.textMuted}> · </text>
      </Show>
      <For each={segments()}>
        {(item, index) => (
          <>
            {index() > 0 && <text fg={theme.textMuted}> · </text>}
            <text
              wrapMode="none"
              fg={item.key === "model" ? theme.text : item.key === "context" ? contextColor() : theme.textMuted}
              onMouseUp={() => {
                if (item.key === "model") dialog.replace(() => <DialogModel />)
                if (item.key === "shortcut") keymap.dispatchCommand("command.palette.show")
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
