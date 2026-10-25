import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionContextManagement } from "@miao/schema/session-context-management"
import { useTheme } from "../../context/theme"

export function PruningSettlement(props: { value: unknown }) {
  const { theme } = useTheme()
  const [store, setStore] = createStore({ expanded: false })
  const pruning = createMemo(() => SessionContextManagement.decodePruning(props.value))
  return (
    <Show when={pruning()}>
      {(value) => (
        <box marginTop={1} paddingLeft={2} paddingRight={2} flexShrink={0}>
          <text fg={theme.textMuted} onMouseUp={() => setStore("expanded", !store.expanded)}>
            {store.expanded ? "▾" : "▸"} Tool output pruned ·{" "}
            <span style={{ fg: theme.success }}>saved {value().savedBytes.toLocaleString()} bytes</span>
          </text>
          <Show when={store.expanded}>
            <text fg={theme.textMuted} wrapMode="word">
              {value().beforeBytes.toLocaleString()} → {value().afterBytes.toLocaleString()} UTF-8 bytes · payloads:{" "}
              {value().payloads} · messages: {value().messages}
            </text>
            <text fg={theme.textMuted} wrapMode="word">
                Tool output budget applied to this request · original output remains available through recall
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

export function CompactionSettlement(props: { summary: string; through?: unknown }) {
  const { theme } = useTheme()
  const [store, setStore] = createStore({ expanded: false })
  return (
    <box marginTop={1} paddingLeft={2} paddingRight={2} flexShrink={0}>
      <text fg={theme.textMuted} onMouseUp={() => setStore("expanded", !store.expanded)}>
        {store.expanded ? "▾" : "▸"} Context compacted
      </text>
      <Show when={store.expanded}>
        <Show when={typeof props.through === "number" && Number.isSafeInteger(props.through) && props.through >= 0}>
          <text fg={theme.textMuted}>History through message sequence {String(props.through)}</text>
        </Show>
        <text fg={theme.textMuted} wrapMode="word">
          {props.summary}
        </text>
      </Show>
    </box>
  )
}
