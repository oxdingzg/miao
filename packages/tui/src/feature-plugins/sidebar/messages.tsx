import type { TuiPlugin, TuiPluginApi } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, Show } from "solid-js"
import { sessionMessageEntries } from "../../util/session-message"

const id = "internal:sidebar-messages"

/** The sidebar summarises recent coordination; full history stays in the transcript. */
const MAX = 8

function summarize(body: string) {
  const line = body.split("\n").find((value) => value.trim().length > 0)?.trim() ?? ""
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

function peerLabel(api: TuiPluginApi, peer: string) {
  if (peer.startsWith("@")) return peer
  const session = api.state.session.get(peer)
  if (!session) return `@${peer.slice(-6)}`
  const title = session.title
  return title.length > 24 ? `${title.slice(0, 23)}…` : title
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [open, setOpen] = createSignal(true)
  const items = createMemo(() =>
    sessionMessageEntries(
      props.api.state.session.messages(props.session_id),
      (messageID) => props.api.state.part(messageID),
    ).slice(-MAX),
  )
  const shown = createMemo(() => (open() ? items() : items().slice(-2)))

  return (
    <Show when={items().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => items().length > 2 && setOpen((x) => !x)}>
          <Show when={items().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Messages</b>
          </text>
        </box>
        <For each={shown()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text fg={entry.direction === "in" ? theme().success : theme().textMuted}>
                {entry.direction === "in" ? "←" : "→"}
              </text>
              <text fg={theme().text}>{peerLabel(props.api, entry.peer)}</text>
              <text fg={theme().textMuted}>{summarize(entry.body)}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 410,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
