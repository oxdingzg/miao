import type {
  SessionMessage,
  TranscriptAssistantMessage,
  TranscriptReasoningPart,
  TranscriptTextPart,
  TranscriptToolPart,
  TranscriptUserMessage,
} from "@miao/schema/view-models"

type Base = { id?: string; sessionID?: string; created?: number; metadata?: Record<string, unknown> }

export function testUserMessage(input: {
  id?: string
  sessionID?: string
  text: string
  created?: number
  parent?: never
  files?: TranscriptUserMessage["files"]
}): TranscriptUserMessage {
  return {
    id: input.id ?? "msg_user",
    type: "user",
    text: input.text,
    time: { created: input.created ?? 0 },
    ...(input.files === undefined ? {} : { files: input.files }),
  } as TranscriptUserMessage
}

export function testAssistantMessage(input: {
  id?: string
  sessionID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  created?: number
  completed?: number
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  ttft?: number
  finish?: string
  content?: Array<TranscriptTextPart | TranscriptReasoningPart | TranscriptToolPart>
}): TranscriptAssistantMessage {
  return {
    id: input.id ?? "msg_assistant",
    type: "assistant",
    agent: input.agent ?? "build",
    model: { id: "some-model", providerID: "some-provider", ...(input.model ?? {}) },
    content: input.content ?? [],
    cost: input.cost ?? 0,
    tokens: input.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: input.created ?? 0,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.ttft === undefined ? {} : { ttft: input.ttft }),
    ...(input.finish === undefined ? {} : { finish: input.finish }),
  } as TranscriptAssistantMessage
}

export function testTextPart(id: string, text: string): TranscriptTextPart {
  return { type: "text", id, text }
}

export function testReasoningPart(
  id: string,
  text: string,
  time?: { created?: number; completed?: number },
): TranscriptReasoningPart {
  return {
    type: "reasoning",
    id,
    text,
    ...(time === undefined ? {} : { time: { ...(time.created === undefined ? {} : { created: time.created }), ...(time.completed === undefined ? {} : { completed: time.completed }) } }),
  } as TranscriptReasoningPart
}

export type TestToolStatus = "pending" | "running" | "completed" | "error"

export function testToolPart(
  id: string,
  name: string,
  status: TestToolStatus,
  options: {
    created?: number
    ran?: number
    completed?: number
    output?: string
    input?: Record<string, unknown>
  } = {},
): TranscriptToolPart {
  const base = { id, name, time: { created: options.created ?? 0 } }
  if (status === "pending") return { ...base, type: "tool", state: { status: "pending", input: "" } } as TranscriptToolPart
  if (status === "running")
    return {
      ...base,
      type: "tool",
      state: { status: "running", input: options.input ?? {}, structured: {}, content: [] },
    } as TranscriptToolPart
  const content = [
    ...(options.output === undefined ? [] : [{ type: "text" as const, text: options.output }]),
  ]
  if (status === "error")
    return {
      ...base,
      type: "tool",
      state: {
        status: "error",
        input: options.input ?? {},
        content,
        structured: {},
        error: { type: "unknown", message: "failed" },
      },
    } as TranscriptToolPart
  return {
    ...base,
    type: "tool",
    state: {
      status: "completed",
      input: options.input ?? {},
      attachments: undefined,
      content,
      ...(options.output === undefined ? {} : { outputPath: undefined }),
    },
  } as TranscriptToolPart
}

export type TestTranscriptMessage = SessionMessage
