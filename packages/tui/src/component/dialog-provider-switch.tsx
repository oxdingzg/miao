import { createMemo } from "solid-js"
import { map, pipe, sortBy } from "remeda"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"
import { DialogProvider } from "./dialog-provider"

export function DialogProviderSwitch() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()

  const options = createMemo(() =>
    pipe(
      sync.data.provider,
      sortBy((provider) => provider.name),
      map((provider) => ({
        title: provider.name,
        value: provider.id,
        description: provider.id === local.model.current()?.providerID ? "(Current)" : undefined,
        onSelect() {
          dialog.replace(() => <DialogModel providerID={provider.id} />)
        },
      })),
    ),
  )

  return (
    <DialogSelect
      title="Switch provider"
      options={options()}
      current={local.model.current()?.providerID}
      actions={[
        {
          command: "model.dialog.provider",
          title: "Connect provider",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
      ]}
    />
  )
}
