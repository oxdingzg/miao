import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { TranscriptUserMessage } from "@miao/schema/view-models"
import { promptInfoFromUserMessage } from "../../context/session-v2-write"
import type { PromptInfo } from "../../prompt/history"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => {
    const found = sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID)
    return found?.type === "user" ? (found as TranscriptUserMessage) : undefined
  })
  const route = useRoute()
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            void sdk.api.sessions.stage({ sessionID: props.sessionID, messageID: msg.id })

            if (props.setPrompt) {
              props.setPrompt(promptInfoFromUserMessage(msg))
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            await clipboard.write?.(msg.text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.api.sessions
              .fork({ sessionID: props.sessionID, messageID: props.messageID })
              .then((r) => ({ data: r }))
            const prompt = message() ? promptInfoFromUserMessage(message() as TranscriptUserMessage) : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
