import type { Part, SessionStatus } from "@miao/schema/view-models"
import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@/utils/server"
import { createMemo, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  records: Accessor<SessionMessageInfo[]>
  projectedUserMessages: Accessor<SessionMessageUser[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.records().map((message) => [message.id, message] as const)))
  // V2 records carry no parentID: assistants join the turn opened by the
  // preceding user/synthetic record, in order (same grouping as rows.ts).
  const assistantsByTurn = createMemo(() => {
    const result = new Map<string, SessionMessageAssistant[]>()
    let open: string | undefined
    input.records().forEach((message) => {
      if (message.type === "user" || message.type === "synthetic") {
        open = message.id
        return
      }
      if (message.type === "shell") {
        open = undefined
        return
      }
      if (message.type !== "assistant" || !open) return
      const list = result.get(open)
      if (list) list.push(message)
      else result.set(open, [message])
    })
    return result
  })
  const projection = createMemo(() =>
    Timeline.constructSessionMessageRows(
      input.records(),
      input.parts,
      input.showReasoningSummaries(),
      input.status().type,
      input.inlineComments(),
      input.projectedUserMessages(),
    ),
  )
  const activeMessageID = createMemo(() => projection().activeMessageID)
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(previous, projection().rows),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantsByTurn,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
