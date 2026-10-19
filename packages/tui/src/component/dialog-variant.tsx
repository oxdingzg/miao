import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: () => {
          dialog.clear()
          void local.model.variant.select(undefined)
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          void local.model.variant.select(variant)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      compact
      options={options()}
      locked={local.model.variant.busy()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
