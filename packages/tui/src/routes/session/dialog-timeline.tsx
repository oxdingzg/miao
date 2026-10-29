import { createMemo, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import type { SessionMessage, TranscriptTextPart } from "@miao/schema/view-models"

/** The text a timeline search matches on: a prompt's own text, or a reply's first text block. */
export function searchableMessageText(message: SessionMessage): string {
  if (message.type === "user") return message.text
  if (message.type === "assistant")
    return message.content.find((part): part is TranscriptTextPart => part.type === "text")?.text ?? ""
  return ""
}

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      // The search covers both sides of the conversation, not just prompts.
      const text = searchableMessageText(message)
      if (text.trim().length === 0) continue
      result.push({
        title: `${message.type === "user" ? "prompt" : "reply"} · ${text.replace(/\n/g, " ")}`,
        value: message.id,
        footer: Locale.todayTimeOrDateTime(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Timeline" options={options()} />
}
