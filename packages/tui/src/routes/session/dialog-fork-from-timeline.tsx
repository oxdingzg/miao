import { createMemo, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TranscriptUserMessage } from "@miao/schema/view-models"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import { promptInfoFromUserMessage } from "../../context/session-v2-write"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        const forked = await sdk.api.sessions.fork({ sessionID: props.sessionID }).then((r) => ({ data: r }))
        route.navigate({
          sessionID: forked.data!.id,
          type: "session",
        })
        dialog.clear()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of messages) {
      if (message.type !== "user") continue
      const user = message as TranscriptUserMessage
      if (user.text.trim().length === 0) continue
      result.push({
        title: user.text.replace(/\n/g, " "),
        value: user.id,
        footer: Locale.time(user.time.created),
        onSelect: async (dialog) => {
          const forked = await sdk.api.sessions
            .fork({ sessionID: props.sessionID, messageID: user.id })
            .then((r) => ({ data: r }))
          route.navigate({
            sessionID: forked.data!.id,
            type: "session",
            prompt: promptInfoFromUserMessage(user),
          })
          dialog.clear()
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}
