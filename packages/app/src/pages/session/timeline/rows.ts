import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageSynthetic,
  SessionMessageUser,
} from "@/utils/server"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@miao/schema/view-models"
import { groupParts, renderable, type PartGroup } from "@miao/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { compareMessages } from "@/utils/session-message"

export { TimelineRow, type SummaryDiff } from "./timeline-row"

/** Turn-opening V2 records: the shell command runs as its own turn. */
export type TurnUser = SessionMessageUser | SessionMessageShell | SessionMessageSynthetic
/** V2 assistant records join the turn that opened before them, in order. */
export type TurnAssistant = SessionMessageAssistant

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
}

export namespace Timeline {
  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
  ) {
    const turns: { user: TurnUser; assistants: TurnAssistant[] }[] = []
    const turnByUserID = new Map<string, (typeof turns)[number]>()

    // V2-native turn construction: turns open on user/synthetic/shell records
    // and every following assistant joins the open turn in order. No V1
    // message lookup is involved.
    let openTurn: (typeof turns)[number] | undefined
    messages.forEach((message) => {
      if (message.type === "agent-switched" || message.type === "model-switched") return
      if (message.type === "shell") {
        // The shell's output parts live under `${id}:assistant`; a minimal
        // assistant stub makes the parts lookup render them in this turn.
        openTurn = {
          user: message,
          assistants: [
            {
              id: `${message.id}:assistant`,
              type: "assistant",
              time: message.time,
            } as unknown as TurnAssistant,
          ],
        }
        turns.push(openTurn)
        turnByUserID.set(message.id, openTurn)
        return
      }
      if (message.type === "user" || (message.type === "synthetic" && message.text.trim())) {
        if (turnByUserID.has(message.id)) return
        openTurn = { user: message, assistants: [] }
        turns.push(openTurn)
        turnByUserID.set(message.id, openTurn)
        return
      }
      if (message.type === "assistant") {
        if (!openTurn) return
        openTurn.assistants.push(message)
        return
      }
    })

    // Optimistic pending prompts render as turns before the protocol record
    // arrives; slot them by time so they sit before newer turns.
    projectedUserMessages.forEach((user) => {
      if (turnByUserID.has(user.id)) return
      const turn = {
        user: {
          id: user.id,
          type: "user",
          text: "",
        agents: undefined,
          time: { created: user.time.created },
        } as unknown as TurnUser,
        assistants: [] as TurnAssistant[],
      }
      turnByUserID.set(user.id, turn)
      const index = turns.findIndex((item) => compareMessages(user, item.user) < 0)
      if (index < 0) turns.push(turn)
      else turns.splice(index, 0, turn)
    })

    const activeMessageID = turns.at(-1)?.user.id
    return {
      activeMessageID,
      rows: turns.flatMap((turn, index) =>
        constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          index,
          showReasoning,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
        ),
      ),
    }
  }

  export function constructMessageRows(
    userMessage: TurnUser & { summary?: { diffs: SummaryDiff[] } },
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: TurnAssistant[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    // V2 errors are `{ type: "unknown", message }`; older records kept the
    // named-error shape with the text under `data.message`. Both mean abort.
    const errorText = (error: unknown): string | undefined => {
      if (!error || typeof error !== "object") return undefined
      const candidate = error as { message?: unknown; data?: { message?: unknown } }
      if (typeof candidate.message === "string") return candidate.message
      if (
        candidate.data &&
        typeof candidate.data === "object" &&
        "message" in candidate.data &&
        typeof candidate.data.message === "string"
      )
        return candidate.data.message
      return undefined
    }
    const aborted = (message: TurnAssistant) => {
      const error = message.error as { name?: unknown } | undefined
      if (error && typeof error.name === "string" && error.name.toLowerCase().includes("abort")) return true
      return errorText(message.error)?.toLowerCase().includes("abort") ?? false
    }
    const interruptedMessageIndex = assistantMessages.findIndex(aborted)
    const interrupted = interruptedMessageIndex !== -1
    const latestError = assistantMessages.at(-1)?.error
    const error = latestError && latestError.message.toLowerCase().includes("abort") ? undefined : latestError

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: inlineComments || comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    let assistantGroupIndex = 0
    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
        }),
      )
      assistantGroupIndex += 1
    })

    if (isActive && status === "busy" && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error) {
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(errorText(error) ?? ""),
        }),
      )
    }

    return rows
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
