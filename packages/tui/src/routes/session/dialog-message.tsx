import { Locale } from "../../util/locale"
import { useTheme } from "../../context/theme"
import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { TranscriptUserMessage } from "@miao/schema/view-models"
import { promptInfoFromUserMessage } from "../../context/session-v2-write"
import type { PromptInfo } from "../../prompt/history"
import { searchableMessageText } from "./dialog-timeline"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const { theme } = useTheme()
  const sdk = useSDK()
  // A reply reached from the timeline search is copyable but has no user-side
  // actions: revert and fork are prompt-boundary operations.
  const message = createMemo(() => {
    const found = sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID)
    if (found?.type === "user") return found as TranscriptUserMessage
    if (found?.type === "assistant") return found
    return undefined
  })
  const isPrompt = createMemo(() => message()?.type === "user")
  const rawText = createMemo(() => {
    const current = message()
    return current ? searchableMessageText(current) : ""
  })
  const route = useRoute()
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      footer={<text fg={theme.textMuted}>{Locale.preciseTime(message()?.time.created)}</text>}
      options={[
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const text = rawText()
            if (!text) return

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        ...(isPrompt()
          ? [
              {
                title: "Revert",
                value: "session.revert",
                description: "undo messages and file changes",
                onSelect: (dialog: { clear: () => void }) => {
                  const msg = message()
                  if (!msg || msg.type !== "user") return

                  void sdk.api.sessions.stage({ sessionID: props.sessionID, messageID: msg.id })

                  if (props.setPrompt) {
                    props.setPrompt(promptInfoFromUserMessage(msg))
                  }

                  dialog.clear()
                },
              },
              {
                title: "Fork",
                value: "session.fork",
                description: "create a new session",
                onSelect: async (dialog: { clear: () => void }) => {
                  const result = await sdk.api.sessions
                    .fork({ sessionID: props.sessionID, messageID: props.messageID })
                    .then((r) => ({ data: r }))
                  const prompt = message()?.type === "user" ? promptInfoFromUserMessage(message() as TranscriptUserMessage) : undefined
                  route.navigate({
                    sessionID: result.data!.id,
                    type: "session",
                    prompt,
                  })
                  dialog.clear()
                },
              },
            ]
          : []),
      ]}
    />
  )
}
