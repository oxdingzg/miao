// Maps V2 tool calls onto ACP tool-call notifications. Pure: the same mapping
// serves live events and history replay.
import { isAbsolute, resolve } from "node:path"
import type { ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk"

export type ToolInput = Readonly<Record<string, unknown>>

export type ToolOutputItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

export type ToolCallInfo = {
  readonly callID: string
  readonly name: string
  readonly input: ToolInput
  readonly cwd: string
}

export function toolKind(name: string): ToolKind {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return "execute"
    case "webfetch":
      return "fetch"
    case "edit":
    case "apply_patch":
    case "patch":
    case "write":
      return "edit"
    case "grep":
    case "glob":
    case "websearch":
      return "search"
    case "read":
      return "read"
    case "task":
      return "think"
    default:
      return "other"
  }
}

export function toolTitle(name: string, input: ToolInput) {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return text(input.command) ?? name
    case "read":
    case "edit":
    case "write":
      return filePath(input) ?? name
    case "grep":
    case "glob":
      return text(input.pattern) ?? name
    case "webfetch":
      return text(input.url) ?? name
    case "websearch":
      return text(input.query) ?? name
    case "task":
      return text(input.description) ?? name
    case "apply_patch": {
      const files = patchFiles(input)
      if (files.length === 1) return files[0]
      if (files.length > 1) return `${files.length} files`
      return name
    }
    default:
      return name
  }
}

export function toolLocations(name: string, input: ToolInput, cwd: string): ToolCallLocation[] {
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return [{ path: resolvePath(text(input.workdir) ?? text(input.cwd), cwd) ?? cwd }]
    case "read":
    case "edit":
    case "write":
      return locations([filePath(input)], cwd)
    case "grep":
    case "glob":
      return locations([text(input.path)], cwd)
    case "apply_patch":
      return locations(patchFiles(input), cwd)
    default:
      return []
  }
}

/** Shell input gains the resolved working directory so clients can show where a command runs. */
export function toolRawInput(name: string, input: ToolInput, cwd: string): ToolInput {
  const kind = toolKind(name)
  if (kind !== "execute" || input.workdir || input.cwd) return input
  return { ...input, cwd }
}

export function pendingToolCall(info: ToolCallInfo): ToolCall {
  return {
    toolCallId: info.callID,
    title: toolTitle(info.name, info.input),
    kind: toolKind(info.name),
    status: "pending",
    locations: toolLocations(info.name, info.input, info.cwd),
    rawInput: toolRawInput(info.name, info.input, info.cwd),
  }
}

export function runningToolUpdate(info: ToolCallInfo, output?: ReadonlyArray<ToolOutputItem>): ToolCallUpdate {
  const content = output ? outputContent(output) : []
  return {
    toolCallId: info.callID,
    status: "in_progress",
    kind: toolKind(info.name),
    title: toolTitle(info.name, info.input),
    locations: toolLocations(info.name, info.input, info.cwd),
    rawInput: toolRawInput(info.name, info.input, info.cwd),
    ...(content.length > 0 ? { content } : {}),
  }
}

export function completedToolUpdate(
  info: ToolCallInfo,
  output: ReadonlyArray<ToolOutputItem>,
  extra?: { readonly structured?: unknown; readonly result?: unknown },
): ToolCallUpdate {
  return {
    toolCallId: info.callID,
    status: "completed",
    kind: toolKind(info.name),
    title: toolTitle(info.name, info.input),
    locations: toolLocations(info.name, info.input, info.cwd),
    rawInput: toolRawInput(info.name, info.input, info.cwd),
    content: [...outputContent(output), ...editDiff(info)],
    rawOutput: {
      output: outputText(output),
      ...(extra?.structured !== undefined && !isEmptyObject(extra.structured) ? { structured: extra.structured } : {}),
      ...(extra?.result !== undefined ? { result: extra.result } : {}),
    },
  }
}

export function failedToolUpdate(info: ToolCallInfo, error: string): ToolCallUpdate {
  return {
    toolCallId: info.callID,
    status: "failed",
    kind: toolKind(info.name),
    title: toolTitle(info.name, info.input),
    locations: toolLocations(info.name, info.input, info.cwd),
    rawInput: toolRawInput(info.name, info.input, info.cwd),
    content: [{ type: "content", content: { type: "text", text: error } }],
    rawOutput: { error },
  }
}

export function outputText(output: ReadonlyArray<ToolOutputItem>) {
  return output
    .filter((item): item is Extract<ToolOutputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n")
}

function outputContent(output: ReadonlyArray<ToolOutputItem>): ToolCallContent[] {
  const body = outputText(output)
  const images = output.flatMap((item): ToolCallContent[] => {
    if (item.type !== "file") return []
    const image = dataImage(item.uri, item.mime)
    return image ? [{ type: "content", content: { type: "image", mimeType: image.mime, data: image.data } }] : []
  })
  return [...(body ? [{ type: "content" as const, content: { type: "text" as const, text: body } }] : []), ...images]
}

function editDiff(info: ToolCallInfo): ToolCallContent[] {
  if (toolKind(info.name) !== "edit") return []
  const path = filePath(info.input)
  const oldText = text(info.input.oldString)
  const newText = text(info.input.newString)
  if (!path || oldText === undefined || newText === undefined) return []
  return [{ type: "diff", path: resolvePath(path, info.cwd) ?? path, oldText, newText }]
}

function dataImage(uri: string, mime: string) {
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s.exec(uri)
  const type = match?.[1] ?? mime
  if (!type.startsWith("image/") || match?.[2] === undefined) return undefined
  return { mime: type, data: match[2] }
}

/** File paths named by an apply_patch envelope (`*** Add File: x`, `*** Update File: x`, ...). */
function patchFiles(input: ToolInput) {
  const patch = text(input.patchText) ?? ""
  return [
    ...new Set(
      patch
        .split("\n")
        .flatMap((line) => /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())?.[1] ?? [])
        .map((file) => file.trim()),
    ),
  ]
}

function filePath(input: ToolInput) {
  return text(input.path) ?? text(input.filePath) ?? text(input.filepath)
}

function locations(paths: ReadonlyArray<string | undefined>, cwd: string): ToolCallLocation[] {
  return [...new Set(paths.flatMap((path) => (path ? [resolvePath(path, cwd) ?? path] : [])))].map((path) => ({ path }))
}

function resolvePath(value: string | undefined, cwd: string) {
  if (!value) return undefined
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function isEmptyObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
