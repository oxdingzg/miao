import type { TuiPlugin } from "@miao/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { StatusLine } from "../../component/status-line"
import { useHomeSessionDestination } from "../../routes/home/session-destination"

const id = "internal:home-footer"

function View() {
  const destination = useHomeSessionDestination()
  const directory = createMemo(() => {
    const selected = destination?.destination()
    return selected?.type === "directory" ? selected.directory : undefined
  })
  return <StatusLine directory={directory()} newWorkspace={destination?.destination()?.type === "new"} />
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
