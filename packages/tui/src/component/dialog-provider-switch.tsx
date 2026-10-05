import { createMemo, onMount } from "solid-js"
import { map, pipe, sortBy } from "remeda"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"
import { DialogProvider } from "./dialog-provider"

export function DialogProviderSwitch() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  // The catalog carries every known provider, including ones with no stored
  // credential. Load it so a provider the user has not connected yet is still
  // discoverable here, not only in the separate Connect dialog.
  onMount(() => {
    sync.loadProviderCatalog().catch(toast.error)
  })

  const options = createMemo(() => {
    const connected = new Set(sync.data.provider.map((provider) => provider.id))
    const connectable = pipe(
      sync.data.provider_next.all,
      sortBy((provider) => provider.name),
      map((provider) => ({
        title: provider.name,
        value: `connect:${provider.id}`,
        description: "Connect",
        category: "Not connected",
        onSelect() {
          dialog.replace(() => <DialogProvider />)
        },
      })),
    ).filter((option) => !connected.has(option.value.slice("connect:".length)))
    const connectedOptions = pipe(
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
    )
    return [...connectedOptions, ...connectable]
  })

  return (
    <DialogSelect
      compact
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
