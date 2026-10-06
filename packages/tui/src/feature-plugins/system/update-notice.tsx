import type { TuiPlugin, TuiPluginApi } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createRoot, createSignal, Show } from "solid-js"

const id = "internal:update-notice"

function Notice(props: { api: TuiPluginApi; installed: () => string | undefined }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.installed()}>
      <text fg={theme().success}>✓ Update installed · Restart to update</text>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const installed = createRoot(() => {
    const [installed, setInstalled] = createSignal<string>()
    api.event.on("installation.updated", (event) => setInstalled(event.properties.version))
    return installed
  })

  api.slots.register({
    order: 100,
    slots: {
      home_prompt_right() {
        return <Notice api={api} installed={installed} />
      },
      session_prompt_right() {
        return <Notice api={api} installed={installed} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
