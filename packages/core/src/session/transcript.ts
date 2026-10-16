// Pure transient transcript projection shared by native history reads and
// the TUI. It depends only on Schema/Effect, writes no storage, and keeps the
// wire-shaped transcript identical for replay and live delivery.
export * as SessionTranscript from "./transcript"

import type { EventView } from "@miao/schema/event-view"
import type { ViewModels } from "@miao/schema/view-models"
type Message = ViewModels.SessionMessage

type Assistant = Extract<Message, { type: "assistant" }>
type User = Extract<Message, { type: "user" }>
type Shell = Extract<Message, { type: "shell" }>
type ToolState = Extract<Assistant["content"][number], { type: "tool" }>["state"]
type ToolContent = Extract<ToolState, { status: "completed" }>["content"]

export type Reduction = {
  sessionID: string
  messages: Message[]
  touched: string[]
}

export function create() {
  // Preserve stream ordinals across history loads and subsequent live events.
  const streams = new Map<string, { text: (string | undefined)[]; reasoning: (string | undefined)[] }>()

  const stream = (sessionID: string, assistantMessageID: string, source: readonly Message[]) => {
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

  const reduce = (source: readonly Message[], event: EventView.Event): Reduction | undefined => {
    if (event.type === "server.instance.disposed") return
    const result = (sessionID: string, messages: Message[], touched: string[] = []): Reduction => ({
      sessionID,
      messages,
      touched,
    })
    const append = (sessionID: string, message: Message) =>
      result(sessionID, source.some((item) => item.id === message.id) ? [...source] : [...source, message], [
        message.id,
      ])

    switch (event.type) {
      // Admission only marks an input as accepted; the visible message appears on promotion.
      case "session.next.stream.discarded": {
        const sessionID = event.properties.sessionID
        const id = event.properties.assistantMessageID
        streams.delete(`${sessionID}:${id}`)
        return result(
          sessionID,
          source.filter((item) => item.id !== id),
          [id],
        )
      }
      // Native streams carry no `step.started` (the engine does not know product
      // agent/model identities), so this evidence is what makes the assistant
      // exist before its commit. Wire model facts stay unknown here.
      case "session.next.assistant.identity":
        return updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            agent: event.properties.agent ?? item.agent,
            model: event.properties.model ?? item.model,
          }),
        )
      case "session.next.prompt.admitted":
        return result(event.properties.sessionID, [...source])
      case "session.next.prompted":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "user",
          text: event.properties.prompt.text,
          command: event.properties.prompt.command,
          files: event.properties.prompt.files,
          agents: event.properties.prompt.agents,
          time: { created: event.properties.timestamp },
        })
      case "session.next.command.started":
        return updateMessage<User>(
          source,
          (item): item is User => item.type === "user" && item.id === event.properties.messageID,
          (item) => ({ ...item, commandState: "running" }),
          event.properties.sessionID,
        )
      case "session.next.command.completed":
        return updateMessage<User>(
          source,
          (item): item is User => item.type === "user" && item.id === event.properties.messageID,
          (item) => ({
            ...item,
            text: event.properties.prompt.text,
            files: event.properties.prompt.files,
            agents: event.properties.prompt.agents,
            commandState: "completed",
          }),
          event.properties.sessionID,
        )
      case "session.next.command.failed":
        return updateMessage<User>(
          source,
          (item): item is User => item.type === "user" && item.id === event.properties.messageID,
          (item) => ({
            ...item,
            text: event.properties.text,
            commandState: "failed",
            commandError: event.properties.error,
          }),
          event.properties.sessionID,
        )
      case "session.next.agent.switched":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "agent-switched",
          agent: event.properties.agent,
          time: { created: event.properties.timestamp },
        })
      case "session.next.model.switched":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "model-switched",
          model: event.properties.model,
          time: { created: event.properties.timestamp },
        })
      case "session.next.synthetic":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "synthetic",
          sessionID: event.properties.sessionID,
          text: event.properties.text,
          time: { created: event.properties.timestamp },
        })
      case "session.next.context.updated":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "system",
          text: event.properties.text,
          time: { created: event.properties.timestamp },
        })
      case "session.next.shell.started":
        return append(event.properties.sessionID, {
          id: event.properties.messageID,
          type: "shell",
          callID: event.properties.callID,
          command: event.properties.command,
          output: "",
          time: { created: event.properties.timestamp },
        })
      case "session.next.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.callID === event.properties.callID,
          (item) => ({
            ...item,
            output: event.properties.output,
            time: { ...item.time, completed: event.properties.timestamp },
          }),
          event.properties.sessionID,
        )
      case "session.next.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.properties.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant"
                  ? { ...item, time: { ...item.time, completed: event.properties.timestamp } }
                  : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.properties.assistantMessageID)
        if (existing?.type === "assistant")
          return result(
            event.properties.sessionID,
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.properties.agent,
                    model: event.properties.model,
                    contextBudget: event.properties.contextBudget,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.properties.snapshot ? { start: event.properties.snapshot } : item.snapshot,
                    time: { ...item.time, completed: undefined },
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          event.properties.sessionID,
          [
            ...completed,
            {
              id: event.properties.assistantMessageID,
              type: "assistant",
              agent: event.properties.agent,
              model: event.properties.model,
              contextBudget: event.properties.contextBudget,
              content: [],
              snapshot: event.properties.snapshot ? { start: event.properties.snapshot } : undefined,
              time: { created: event.properties.timestamp },
            },
          ],
          current ? [current.id, event.properties.assistantMessageID] : [event.properties.assistantMessageID],
        )
      }
      case "session.next.step.ended":
        return updateAssistant(source, event.properties.assistantMessageID, event.properties.sessionID, (item) => ({
          ...item,
          finish: event.properties.finish,
          cost: event.properties.cost,
          tokens: event.properties.tokens,
          ttft: event.properties.ttft,
          snapshot:
            event.properties.snapshot || event.properties.files
              ? { ...item.snapshot, end: event.properties.snapshot, files: event.properties.files }
              : item.snapshot,
          time: { ...item.time, completed: event.properties.timestamp },
        }))
      case "session.next.step.failed":
        return updateAssistant(source, event.properties.assistantMessageID, event.properties.sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.properties.error,
          time: { ...item.time, completed: event.properties.timestamp },
        }))
      case "session.next.text.started":
        return updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "text",
              position(stream(event.properties.sessionID, item.id, source).text, event.properties.textID),
              { type: "text", id: event.properties.textID, text: "" },
            ),
          }),
        )
      case "session.next.text.delta": {
        const prepared = updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "text",
              position(
                stream(event.properties.sessionID, event.properties.assistantMessageID, source).text,
                event.properties.textID,
              ),
              { type: "text", id: event.properties.textID, text: "" },
            ),
          }),
        )
        return updateContent(
          prepared.messages,
          event.properties.assistantMessageID,
          event.properties.sessionID,
          "text",
          position(
            stream(event.properties.sessionID, event.properties.assistantMessageID, source).text,
            event.properties.textID,
          ),
          (item) => ({ ...item, text: item.text + event.properties.delta }),
        )
      }
      case "session.next.text.ended": {
        // Historical native commits may have no started/delta events. The
        // final text is authoritative and must create its missing part.
        const prepared = updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "text",
              position(stream(event.properties.sessionID, item.id, source).text, event.properties.textID),
              { type: "text", id: event.properties.textID, text: event.properties.text },
            ),
          }),
        )
        return updateContent(
          prepared.messages,
          event.properties.assistantMessageID,
          event.properties.sessionID,
          "text",
          position(
            stream(event.properties.sessionID, event.properties.assistantMessageID, source).text,
            event.properties.textID,
          ),
          (item) => ({ ...item, text: event.properties.text }),
        )
      }
      case "session.next.reasoning.started":
        return updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "reasoning",
              position(stream(event.properties.sessionID, item.id, source).reasoning, event.properties.reasoningID),
              {
                type: "reasoning",
                id: event.properties.reasoningID,
                text: "",
                providerMetadata: event.properties.providerMetadata,
                time: { created: event.properties.timestamp },
              },
            ),
          }),
        )
      case "session.next.reasoning.delta": {
        const prepared = updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "reasoning",
              position(
                stream(event.properties.sessionID, event.properties.assistantMessageID, source).reasoning,
                event.properties.reasoningID,
              ),
              {
                type: "reasoning",
                id: event.properties.reasoningID,
                text: "",
                time: { created: event.properties.timestamp },
              },
            ),
          }),
        )
        return updateContent(
          prepared.messages,
          event.properties.assistantMessageID,
          event.properties.sessionID,
          "reasoning",
          position(
            stream(event.properties.sessionID, event.properties.assistantMessageID, source).reasoning,
            event.properties.reasoningID,
          ),
          (item) => ({ ...item, text: item.text + event.properties.delta }),
        )
      }
      case "session.next.reasoning.ended": {
        const prepared = updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: insertOrdinal(
              item.content,
              "reasoning",
              position(stream(event.properties.sessionID, item.id, source).reasoning, event.properties.reasoningID),
              { type: "reasoning", id: event.properties.reasoningID, text: event.properties.text },
            ),
          }),
        )
        return updateContent(
          prepared.messages,
          event.properties.assistantMessageID,
          event.properties.sessionID,
          "reasoning",
          position(
            stream(event.properties.sessionID, event.properties.assistantMessageID, source).reasoning,
            event.properties.reasoningID,
          ),
          (item) => ({
            ...item,
            text: event.properties.text,
            providerMetadata: event.properties.providerMetadata ?? item.providerMetadata,
            time: { created: item.time?.created ?? event.properties.timestamp, completed: event.properties.timestamp },
          }),
        )
      }
      case "session.next.tool.input.started":
        return updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: item.content.some((content) => content.type === "tool" && content.id === event.properties.callID)
              ? item.content
              : [
                  ...item.content,
                  {
                    type: "tool",
                    id: event.properties.callID,
                    name: event.properties.name,
                    state: { status: "pending", input: "" },
                    time: { created: event.properties.timestamp },
                  },
                ],
          }),
        )
      case "session.next.tool.input.delta":
        return updateTool(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) =>
            tool.state.status === "pending"
              ? { ...tool, state: { ...tool.state, input: tool.state.input + event.properties.delta } }
              : tool,
        )
      case "session.next.tool.input.ended":
        return updateTool(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) =>
            tool.state.status === "pending"
              ? { ...tool, state: { ...tool.state, input: event.properties.text } }
              : tool,
        )
      case "session.next.tool.called": {
        const prepared = updateAssistant(
          ensureAssistant(source, event.properties.assistantMessageID, event.properties.timestamp),
          event.properties.assistantMessageID,
          event.properties.sessionID,
          (item) => ({
            ...item,
            content: item.content.some((part) => part.type === "tool" && part.id === event.properties.callID)
              ? item.content
              : [
                  ...item.content,
                  {
                    type: "tool",
                    id: event.properties.callID,
                    name: event.properties.tool,
                    state: { status: "pending", input: "" },
                    time: { created: event.properties.timestamp },
                  },
                ],
          }),
        )
        return updateTool(
          prepared.messages,
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) => ({
            ...tool,
            provider: event.properties.provider,
            state: { status: "running", input: event.properties.input, structured: {}, content: [] },
            time: { ...tool.time, ran: event.properties.timestamp },
          }),
        )
      }
      case "session.next.tool.progress":
        return updateTool(
          source,
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) =>
            tool.state.status === "running"
              ? {
                  ...tool,
                  state: {
                    ...tool.state,
                    structured: event.properties.structured,
                    content: event.properties.content,
                  },
                }
              : tool,
        )
      case "session.next.tool.success":
        return updateTool(
          source,
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) => {
            if (tool.state.status !== "running") return tool
            return {
              ...tool,
              provider: {
                executed: event.properties.provider.executed || tool.provider?.executed === true,
                metadata: tool.provider?.metadata,
                resultMetadata: event.properties.provider.metadata,
              },
              state: {
                status: "completed",
                input: tool.state.input,
                structured: event.properties.structured,
                content: event.properties.content,
                outputPaths: event.properties.outputPaths,
                result: event.properties.result,
              },
              time: { ...tool.time, completed: event.properties.timestamp },
            }
          },
        )
      case "session.next.tool.failed":
        return updateTool(
          source,
          event.properties.assistantMessageID,
          event.properties.callID,
          event.properties.sessionID,
          (tool) => {
            if (tool.state.status !== "pending" && tool.state.status !== "running") return tool
            return {
              ...tool,
              provider: {
                executed: event.properties.provider.executed || tool.provider?.executed === true,
                metadata: tool.provider?.metadata,
                resultMetadata: event.properties.provider.metadata,
              },
              state: {
                status: "error",
                input: typeof tool.state.input === "string" ? {} : tool.state.input,
                structured: tool.state.status === "running" ? tool.state.structured : {},
                content: tool.state.status === "running" ? tool.state.content : [],
                error: event.properties.error,
                result: event.properties.result,
              },
              time: { ...tool.time, completed: event.properties.timestamp },
            }
          },
        )
      // Retries surface through the session status; compaction/revert/moved are handled by a full
      // re-sync because they rewrite the transcript rather than extend it.
      case "session.next.retried":
      case "session.next.status":
      case "session.next.failed":
      case "session.next.moved":
      case "session.next.created":
      case "session.next.info.updated":
      case "session.next.compaction.started":
      case "session.next.compaction.delta":
      case "session.next.compaction.ended":
      case "session.next.revert.staged":
      case "session.next.revert.cleared":
      case "session.next.revert.committed":
        return result(event.properties.sessionID, [...source])
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

// A native stream's parts can arrive before any committed assistant exists
// (`step.started` requires product identities the engine does not know), so
// streaming cases seed the placeholder they render into.
function ensureAssistant(source: readonly Message[], id: string, timestamp: number): readonly Message[] {
  if (source.some((item) => item.id === id && item.type === "assistant")) return source
  return [
    ...source,
    {
      id,
      type: "assistant",
      agent: null,
      model: null,
      content: [],
      time: { created: timestamp },
    },
  ]
}

// Stream ids arrive in the order their content item was created, so the first sighting of an id
// is the position that item occupies among the others of its type.
function position(list: (string | undefined)[], id: string) {
  const index = list.indexOf(id)
  if (index !== -1) return index
  list.push(id)
  return list.length - 1
}

function update(source: readonly Message[], id: string, apply: (item: Message) => Message) {
  return source.map((item) => (item.id === id ? apply(item) : item))
}

function updateMessage<T extends Message>(
  source: readonly Message[],
  matches: (item: Message) => item is T,
  apply: (item: T) => T,
  sessionID: string,
): Reduction {
  const current = source.findLast(matches)
  if (!current) return { sessionID, messages: [...source], touched: [] }
  return {
    sessionID,
    messages: update(source, current.id, (item) => (matches(item) ? apply(item) : item)),
    touched: [current.id],
  }
}

function updateAssistant(
  source: readonly Message[],
  id: string,
  sessionID: string,
  apply: (item: Assistant) => Assistant,
): Reduction {
  return {
    sessionID,
    messages: update(source, id, (item) => (item.type === "assistant" ? apply(item) : item)),
    touched: source.some((item) => item.id === id && item.type === "assistant") ? [id] : [],
  }
}

function updateContent<T extends "text" | "reasoning">(
  source: readonly Message[],
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
  source: readonly Message[],
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
