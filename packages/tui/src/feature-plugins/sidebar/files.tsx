import type { TuiPlugin, TuiPluginApi } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, createEffect, on } from "solid-js"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-files"

function changeCountWidth(item: { additions: number; deletions: number }) {
  return [item.additions ? `+${item.additions}` : "", item.deletions ? `-${item.deletions}` : ""]
    .filter(Boolean)
    .join(" ").length
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const pageSize = 24
  const [open, setOpen] = createSignal<boolean>()
  const [page, setPage] = createSignal(0)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const expanded = () => open() ?? list().length <= pageSize
  const pageCount = () => Math.ceil(list().length / pageSize)
  const currentPage = () => Math.min(page(), Math.max(0, pageCount() - 1))
  const visible = createMemo(() => list().slice(currentPage() * pageSize, (currentPage() + 1) * pageSize))
  createEffect(
    on(
      () => props.session_id,
      () => {
        setOpen(undefined)
        setPage(0)
      },
    ),
  )

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen(!expanded())}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{expanded() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Modified Files ({list().length})</b>
          </text>
        </box>
        <Show when={list().length <= 2 || expanded()}>
          <For each={visible()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="none">
                  {Locale.truncateLeft(item.file, Math.max(2, 36 - changeCountWidth(item)))}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
          <Show when={pageCount() > 1}>
            <box flexDirection="row" justifyContent="space-between">
              <text
                fg={currentPage() > 0 ? theme().text : theme().textMuted}
                onMouseDown={() => setPage(Math.max(0, currentPage() - 1))}
              >
                ←
              </text>
              <text fg={theme().textMuted}>
                {currentPage() * pageSize + 1}–{Math.min((currentPage() + 1) * pageSize, list().length)} /{" "}
                {list().length}
              </text>
              <text
                fg={currentPage() + 1 < pageCount() ? theme().text : theme().textMuted}
                onMouseDown={() => setPage(Math.min(pageCount() - 1, currentPage() + 1))}
              >
                →
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
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
