import { useSessionState } from "../../context/session-state"
import { sessionStateLabel, todoAge, todoSummary } from "../../util/session-state"
import type { TuiPlugin, TuiPluginApi } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, For, onCleanup, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  // When this window last saw the list change. The panel must not present an
  // hours-old list as the current plan: the model owns the list's content, but
  // its age is observable here.
  const [changedAt, setChangedAt] = createSignal(Date.now())
  createEffect(() => {
    const off = props.api.event.on("todo.updated", (event) => {
      if (event.properties.sessionID === props.session_id) setChangedAt(Date.now())
    })
    onCleanup(off)
  })
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const state = useSessionState()
  const summary = createMemo(() => todoSummary(list()))
  const age = createMemo(() => todoAge(changedAt()))
  const stale = createMemo(() => age().stale && summary().remaining > 0)

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>
              Todo {summary().completed}/{summary().total}
            </b>
          </text>
        </box>
        <text fg={state.state() === "completed" ? theme().success : theme().textMuted}>
          {sessionStateLabel[state.state()]}
          {summary().cancelled > 0 ? ` · ${summary().cancelled} cancelled` : ""}
          {age().label ? ` · updated ${age().label}` : ""}
        </text>
        <Show when={stale()}>
          <text fg={theme().warning}>this list may be stale — ask the agent to refresh todos</text>
        </Show>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <TodoItem status={item.status} content={item.content} id={item.id} depends_on={item.depends_on} />
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
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
