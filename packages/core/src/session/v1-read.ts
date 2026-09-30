export * as SessionV1Read from "./v1-read"

import { DateTime } from "effect"
import type { SessionV1 } from "../v1/session"
import type { SessionMessage } from "./message"

export interface WithParts {
  readonly info: SessionV1.Info
  readonly parts: ReadonlyArray<SessionV1.Part>
}

export interface Options {
  /**
   * Project root the session ran in. Legacy `patch` parts record absolute file
   * paths while V2 snapshot paths are project-relative, so a mapping without
   * this cannot place them. They are omitted rather than emitted absolute,
   * because `Snapshot.restore` resolves entries against the current worktree
   * and would target the wrong path instead of failing.
   */
  readonly directory?: string
}

const at = (millis: number) => DateTime.makeUnsafe(millis)

const toolState = (state: SessionV1.ToolState): SessionMessage.ToolState => {
  switch (state.status) {
    case "pending":
      return { status: "pending", input: JSON.stringify(state.input) }
    case "running":
      return { status: "running", input: state.input, structured: state.metadata ?? {}, content: [] }
    case "completed":
      return {
        status: "completed",
        input: state.input,
        // V2 keeps a tool's textual output in `content` and its remaining
        // metadata in `structured`. Bash metadata carries the same output in an
        // `output` field, so drop that one field instead of storing it twice.
        structured:
          state.metadata.output === state.output
            ? Object.fromEntries(Object.entries(state.metadata).filter(([key]) => key !== "output"))
            : state.metadata,
        content: [{ type: "text", text: state.output }],
        ...(state.attachments === undefined
          ? {}
          : {
              attachments: state.attachments.map((part) => ({
                uri: part.url,
                mime: part.mime,
                ...(part.filename === undefined ? {} : { name: part.filename }),
              })),
            }),
      }
    case "error":
      return {
        status: "error",
        input: state.input,
        structured: state.metadata ?? {},
        content: [],
        error: { type: "unknown", message: state.error },
      }
  }
}

/** Legacy patch paths are absolute; V2 snapshot paths are relative to the project root. */
const relativeTo = (directory: string, file: string) => {
  const root = directory.replaceAll("\\", "/").replace(/\/+$/, "") + "/"
  const path = file.replaceAll("\\", "/")
  return path.startsWith(root) ? path.slice(root.length) : undefined
}

const assistant = (
  info: SessionV1.Assistant,
  parts: ReadonlyArray<SessionV1.Part>,
  directory: string | undefined,
): SessionMessage.Message => {
  const content: SessionMessage.AssistantContent[] = []
  // A legacy assistant message records its span as per-step markers: `step-start`
  // holds the tree before a step and `step-finish` the tree after one, and a
  // `patch` repeats the start tree alongside the files the message changed. The
  // first start and the last finish are the message's own start and end; a
  // patch never carries the end tree, so it cannot supply one on its own. The
  // trees live in the same content-addressed store V2 uses, though a snapshot
  // GC may already have pruned an older one.
  let start: string | undefined
  let end: string | undefined
  const files = new Set<string>()
  for (const part of parts) {
    if (part.type === "step-start" || part.type === "snapshot") {
      start ??= part.snapshot
      continue
    }
    if (part.type === "step-finish") {
      if (part.snapshot !== undefined) end = part.snapshot
      continue
    }
    if (part.type === "patch") {
      start ??= part.hash
      for (const file of part.files) {
        const relative = directory === undefined ? undefined : relativeTo(directory, file)
        if (relative !== undefined) files.add(relative)
      }
      continue
    }
    if (part.type === "text") {
      content.push({ type: "text", id: part.id, text: part.text })
      continue
    }
    if (part.type === "reasoning") {
      content.push({ type: "reasoning", id: part.id, text: part.text })
      continue
    }
    if (part.type !== "tool") continue
    const toolStart = "time" in part.state ? part.state.time.start : undefined
    const toolEnd =
      part.state.status === "completed" || part.state.status === "error" ? part.state.time.end : undefined
    content.push({
      type: "tool",
      id: part.callID,
      name: part.tool,
      state: toolState(part.state),
      time: {
        created: at(toolStart ?? info.time.created),
        ...(toolEnd === undefined ? {} : { completed: at(toolEnd) }),
      },
    })
  }
  const snapshot = {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(files.size === 0 ? {} : { files: Array.from(files) }),
  }
  return {
    id: info.id,
    type: "assistant",
    time: {
      created: at(info.time.created),
      ...(info.time.completed !== undefined ? { completed: at(info.time.completed) } : {}),
    },
    agent: info.agent,
    model: { providerID: info.providerID, id: info.modelID, variant: info.variant },
    content,
    ...(start === undefined && end === undefined && files.size === 0 ? {} : { snapshot }),
    ...(info.finish !== undefined ? { finish: info.finish } : {}),
    cost: info.cost,
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cache: info.tokens.cache,
    },
  } as unknown as SessionMessage.Message
}

const user = (info: SessionV1.User, parts: ReadonlyArray<SessionV1.Part>): SessionMessage.Message => {
  const text = parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
  const files = parts
    .filter((part): part is SessionV1.FilePart => part.type === "file")
    .map((part) => ({ uri: part.url, mime: part.mime, name: part.filename }))
  const agents = parts
    .filter((part): part is SessionV1.AgentPart => part.type === "agent")
    .map((part) => ({ name: part.name }))
  return {
    id: info.id,
    type: "user",
    time: { created: at(info.time.created) },
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  } as unknown as SessionMessage.Message
}

/** Maps a legacy V1 session transcript into the V2 projected message shape (read-only). */
export const map = (messages: ReadonlyArray<WithParts>, options: Options = {}): SessionMessage.Message[] =>
  messages.map(({ info, parts }) =>
    info.role === "user" ? user(info, parts) : assistant(info, parts, options.directory),
  )
