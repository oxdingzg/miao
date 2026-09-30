import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { Flag } from "@miao/core/flag/flag"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={(value) => {
        void (Flag.MIAO_TUI_V2
          ? sdk.client.v2.session.rename({ sessionID: props.session, title: value })
          : sdk.client.session.update({
              sessionID: props.session,
              title: value,
            }))
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
