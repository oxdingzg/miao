import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSync } from "../context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={(value) => {
        void sdk.api.sessions
          .rename({ sessionID: props.session, title: value })
          .catch((error) => toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" }))
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
