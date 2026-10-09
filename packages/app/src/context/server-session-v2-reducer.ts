// Events arrive over SSE in their encoded form, so the reducer reads the encoded union: decoding
// would turn `timestamp` into a DateTime and hand back values the wire never carries.
import type { OpenCodeEventEncoded } from "@miao/protocol/groups/event"
import type { JsonValue } from "@miao/client"
import type { SessionMessageInfo } from "@/utils/server"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type User = Extract<SessionMessageInfo, { type: "user" }>
type Shell = Extract<SessionMessageInfo, { type: "shell" }>
type ToolState = Extract<Assistant["content"][number], { type: "tool" }>["state"]
type ToolContent = Extract<ToolState, { status: "completed" }>["content"]

function record(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export type V2SessionReduction = {
  sessionID: string
  messages: SessionMessageInfo[]
  touched: string[]
}

export function createV2SessionReducer() {
  // Preserve stream ordinals across history loads and subsequent live events.
  const streams = new Map<string, { text: (string | undefined)[]; reasoning: (string | undefined)[] }>()

  const stream = (sessionID: string, assistantMessageID: string, source: readonly SessionMessageInfo[]) => {
    const key = `${sessionID}:${assistantMessageID}`
    const existing = streams.get(key)
    if (existing) return existing
    const message = source.find((item) => item.id === assistantMessageID)
    const content = message?.type === "assistant" ? message.content : []
    const ids = (type: "text" | "reasoning") =>
      content
        .filter((item) => item.type === type)
        .map((item) => ("id" in item && typeof item.id === "string" ? item.id : undefined))
    const created = { text: ids("text"), reasoning: ids("reasoning") }
    streams.set(key, created)
    return created
  }

  const reduce = (
    source: readonly SessionMessageInfo[],
    event: OpenCodeEventEncoded,
  ): V2SessionReduction | undefined => {
    if (!("data" in event) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    const result = (messages: SessionMessageInfo[], touched: string[] = []): V2SessionReduction => ({
      sessionID,
      messages,
      touched,
    })
    const append = (message: SessionMessageInfo) =>
      result(source.some((item) => item.id === message.id) ? [...source] : [...source, message], [message.id])

    switch (event.type) {
      // Admission only marks an input as accepted; the visible message appears on promotion.
      case "session.next.prompt.admitted":
        return result([...source])
      case "session.next.prompted":
        return append({
          id: event.data.messageID,
          type: "user",
          metadata: wire(event.metadata),
          text: event.data.prompt.text,
          command: wire(event.data.prompt.command),
          files: wire(event.data.prompt.files),
          agents: wire(event.data.prompt.agents),
          time: { created: event.data.timestamp },
        })
      case "session.next.command.started":
      case "session.next.command.completed":
      case "session.next.command.failed":
        return updateCommand(source, event)
      case "session.next.agent.switched":
        return append({
          id: event.data.messageID,
          type: "agent-switched",
          metadata: wire(event.metadata),
          agent: event.data.agent,
          time: { created: event.data.timestamp },
        })
      case "session.next.model.switched":
        return append({
          id: event.data.messageID,
          type: "model-switched",
          metadata: wire(event.metadata),
          model: event.data.model,
          time: { created: event.data.timestamp },
        })
      case "session.next.synthetic":
        return append({
          id: event.data.messageID,
          type: "synthetic",
          sessionID: event.data.sessionID,
          text: event.data.text,
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.started":
        return append({
          id: event.data.messageID,
          type: "shell",
          metadata: wire(event.metadata),
          callID: event.data.callID,
          command: event.data.command,
          output: "",
          time: { created: event.data.timestamp },
        })
      case "session.next.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.callID === event.data.callID,
          (item) => ({
            ...item,
            output: event.data.output,
            time: { ...item.time, completed: event.data.timestamp },
          }),
          sessionID,
        )
      case "session.next.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.data.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant" ? { ...item, time: { ...item.time, completed: event.data.timestamp } } : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.data.assistantMessageID)
        if (existing?.type === "assistant")
          return result(
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.data.agent,
                    model: event.data.model,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.data.snapshot ? { ...item.snapshot, start: event.data.snapshot } : item.snapshot,
                    time: { ...item.time, completed: undefined },
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          [
            ...completed,
            {
              id: event.data.assistantMessageID,
              type: "assistant",
              metadata: wire(event.metadata),
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.data.timestamp },
            },
          ],
          current ? [current.id, event.data.assistantMessageID] : [event.data.assistantMessageID],
        )
      }
      case "session.next.step.ended":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: wire(event.data.finish),
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: wire(event.data.files) }
              : item.snapshot,
          time: { ...item.time, completed: event.data.timestamp },
        }))
      case "session.next.step.failed":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.data.error,
          time: { ...item.time, completed: event.data.timestamp },
          // An interrupted turn never settles its in-flight tools; leave them
          // pending and the timeline shows a spinner forever.
          content: item.content.map((content) => {
            if (content.type !== "tool" || content.state.status !== "pending") return content
            const parsed: unknown = JSON.parse(content.state.input || "{}")
            return {
              ...content,
              state: {
                status: "error",
                input: record(parsed) ? parsed : {},
                structured: {},
                content: [],
                error: { type: "unknown", message: "Interrupted" },
                time: { created: content.time.created, ran: content.time.created, completed: event.data.timestamp },
              },
            }
          }),
        }))
      case "session.next.text.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertOrdinal(
            item.content,
            "text",
            position(stream(sessionID, item.id, source).text, event.data.textID),
            { type: "text", id: event.data.textID, text: "" },
          ),
        }))
      case "session.next.text.delta":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "text",
          position(stream(sessionID, event.data.assistantMessageID, source).text, event.data.textID),
          (item) => ({
            ...item,
            text: item.text + event.data.delta,
          }),
        )
      case "session.next.text.ended":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "text",
          position(stream(sessionID, event.data.assistantMessageID, source).text, event.data.textID),
          (item) => ({
            ...item,
            text: event.data.text,
          }),
        )
      case "session.next.reasoning.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: insertOrdinal(
            item.content,
            "reasoning",
            position(stream(sessionID, item.id, source).reasoning, event.data.reasoningID),
            {
              type: "reasoning",
              id: event.data.reasoningID,
              text: "",
              providerMetadata: wire(event.data.providerMetadata),
              time: { created: event.data.timestamp },
            },
          ),
        }))
      case "session.next.reasoning.delta":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          position(stream(sessionID, event.data.assistantMessageID, source).reasoning, event.data.reasoningID),
          (item) => ({
            ...item,
            text: item.text + event.data.delta,
          }),
        )
      case "session.next.reasoning.ended":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          position(stream(sessionID, event.data.assistantMessageID, source).reasoning, event.data.reasoningID),
          (item) => ({
            ...item,
            text: event.data.text,
            providerMetadata: wire(event.data.providerMetadata) ?? item.providerMetadata,
            time: { created: item.time?.created ?? event.data.timestamp, completed: event.data.timestamp },
          }),
        )
      case "session.next.tool.input.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some((content) => content.type === "tool" && content.id === event.data.callID)
            ? item.content
            : [
                ...item.content,
                {
                  type: "tool",
                  id: event.data.callID,
                  name: event.data.name,
                  state: { status: "pending", input: "" },
                  time: { created: event.data.timestamp },
                },
              ],
        }))
      case "session.next.tool.input.delta":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "pending"
            ? { ...tool, state: { ...tool.state, input: tool.state.input + event.data.delta } }
            : tool,
        )
      case "session.next.tool.input.ended":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "pending" ? { ...tool, state: { ...tool.state, input: event.data.text } } : tool,
        )
      case "session.next.tool.called":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => ({
          ...tool,
          provider: wire(event.data.provider),
          // A re-run keeps the settled metadata: the edit renderer reads the
          // diff from `structured` while the tool is running again.
          state: {
            status: "running",
            input: wire(event.data.input),
            structured: ("structured" in tool.state ? tool.state.structured : {}) ?? {},
            content: [],
          },
          time: { ...tool.time, ran: event.data.timestamp },
        }))
      case "session.next.tool.progress":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "running"
            ? {
                ...tool,
                state: {
                  ...tool.state,
                  structured: wire<Record<string, JsonValue>>(event.data.structured),
                  content: wire<ToolContent>(event.data.content),
                },
              }
            : tool,
        )
      case "session.next.tool.success":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "running") return tool
          return {
            ...tool,
            provider: {
              executed: event.data.provider.executed || tool.provider?.executed === true,
              metadata: tool.provider?.metadata,
              resultMetadata: wire(event.data.provider.metadata),
            },
            state: {
              status: "completed",
              input: tool.state.input,
              structured: wire<Record<string, JsonValue>>(event.data.structured),
              content: wire<ToolContent>(event.data.content),
              outputPaths: wire(event.data.outputPaths),
              result: wire(event.data.result),
            },
            time: { ...tool.time, completed: event.data.timestamp },
          }
        })
      case "session.next.tool.failed":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "pending" && tool.state.status !== "running") return tool
          return {
            ...tool,
            provider: {
              executed: event.data.provider.executed || tool.provider?.executed === true,
              metadata: tool.provider?.metadata,
              resultMetadata: wire(event.data.provider.metadata),
            },
            state: {
              status: "error",
              input: typeof tool.state.input === "string" ? {} : tool.state.input,
              structured: tool.state.status === "running" ? tool.state.structured : {},
              content: tool.state.status === "running" ? tool.state.content : [],
              error: event.data.error,
              result: wire(event.data.result),
            },
            time: { ...tool.time, completed: event.data.timestamp },
          }
        })
      // Retries surface through the session status; compaction streams into the timeline only once
      // it settles, matching the server projection.
      case "session.next.retried":
      case "session.next.compaction.started":
      case "session.next.compaction.delta":
        return result([...source])
      case "session.next.compaction.ended":
        return append({
          id: event.data.messageID,
          type: "compaction",
          metadata: wire(event.metadata),
          reason: event.data.reason,
          summary: event.data.text,
          recent: event.data.recent,
          time: { created: event.data.timestamp },
        })
      default:
        return
    }
  }

  return {
    reduce,
    clear(sessionID: string) {
      for (const id of streams.keys()) {
        if (id.startsWith(`${sessionID}:`)) streams.delete(id)
      }
    },
  }
}

// Stream ids arrive in the order their content item was created, so the first sighting of an id
// is the position that item occupies among the others of its type.
function position(list: (string | undefined)[], id: string) {
  const index = list.indexOf(id)
  if (index !== -1) return index
  list.push(id)
  return list.length - 1
}

// The event contract widens values it cannot type and marks collections readonly, while the
// projected message keeps the narrower mutable JSON form. This is where the two shapes meet.
function wire<T>(input: unknown): T {
  return input as T
}

function update(
  source: readonly SessionMessageInfo[],
  id: string,
  apply: (item: SessionMessageInfo) => SessionMessageInfo,
) {
  return source.map((item) => (item.id === id ? apply(item) : item))
}

function updateMessage<T extends SessionMessageInfo>(
  source: readonly SessionMessageInfo[],
  matches: (item: SessionMessageInfo) => item is T,
  apply: (item: T) => T,
  sessionID: string,
): V2SessionReduction {
  const current = source.findLast(matches)
  if (!current) return { sessionID, messages: [...source], touched: [] }
  return {
    sessionID,
    messages: update(source, current.id, (item) => (matches(item) ? apply(item) : item)),
    touched: [current.id],
  }
}

function updateAssistant(
  source: readonly SessionMessageInfo[],
  id: string,
  sessionID: string,
  apply: (item: Assistant) => Assistant,
): V2SessionReduction {
  return {
    sessionID,
    messages: update(source, id, (item) => (item.type === "assistant" ? apply(item) : item)),
    touched: source.some((item) => item.id === id && item.type === "assistant") ? [id] : [],
  }
}

function updateContent<T extends "text" | "reasoning">(
  source: readonly SessionMessageInfo[],
  messageID: string,
  sessionID: string,
  type: T,
  ordinal: number,
  apply: (
    item: Extract<Assistant["content"][number], { type: T }>,
  ) => Extract<Assistant["content"][number], { type: T }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => {
    let index = -1
    return {
      ...assistant,
      content: assistant.content.map((item) => {
        if (item.type !== type || ++index !== ordinal) return item
        return apply(item as Extract<Assistant["content"][number], { type: T }>)
      }),
    }
  })
}

function updateTool(
  source: readonly SessionMessageInfo[],
  messageID: string,
  callID: string,
  sessionID: string,
  apply: (
    item: Extract<Assistant["content"][number], { type: "tool" }>,
  ) => Extract<Assistant["content"][number], { type: "tool" }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => ({
    ...assistant,
    content: assistant.content.map((item) => (item.type === "tool" && item.id === callID ? apply(item) : item)),
  }))
}

function insertOrdinal<T extends Assistant["content"][number]["type"]>(
  source: Assistant["content"],
  type: T,
  ordinal: number,
  item: Extract<Assistant["content"][number], { type: T }>,
) {
  const matches = source.filter((content) => content.type === type)
  if (matches[ordinal]) return source
  return [...source, item]
}

function updateCommand(source: readonly SessionMessageInfo[], event: Extract<OpenCodeEventEncoded, {
  type: "session.next.command.started" | "session.next.command.completed" | "session.next.command.failed"
}>) {
  return updateMessage<User>(source,
    (item): item is User => item.type === "user" && item.id === event.data.messageID,
    (item) => {
      if (event.type === "session.next.command.started") return { ...item, commandState: "running" }
      if (event.type === "session.next.command.failed") return { ...item, text: event.data.text, commandState: "failed", commandError: event.data.error }
      return { ...item, text: event.data.prompt.text, files: wire(event.data.prompt.files), agents: wire(event.data.prompt.agents), commandState: "completed" }
    }, event.data.sessionID)
}
