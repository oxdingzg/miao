import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { contentParts, createSessionContent, sessionMessagePartID } from "./content"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "./content"

const sessionID = "ses_content"
type AssistantContent = SessionMessageAssistant["content"]

const user = (id: string, input: Partial<Extract<SessionMessageInfo, { type: "user" }>> = {}): SessionMessageInfo => ({
  id,
  type: "user",
  text: "hello",
  time: { created: 1 },
  ...input,
})

const assistant = (id: string, content: AssistantContent = []): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content,
  time: { created: 2 },
})

const text = (id: string, body: string): AssistantContent[number] => ({ type: "text", id, text: body })
const reasoning = (id: string, body: string): AssistantContent[number] => ({ type: "reasoning", id, text: body })
const tool = (id: string, name: string, state: SessionMessageAssistantTool["state"]): AssistantContent[number] => ({
  type: "tool",
  id,
  name,
  state,
  time: { created: 1 },
})

describe("timeline content projection", () => {
  test("projects user text, files and agents", () => {
    const parts = contentParts(sessionID, [
      user("u1", {
        files: [{ mime: "text/plain", name: "notes.txt", uri: "file:///repo/notes.txt" }],
        agents: [{ name: "explore" }],
      }),
    ])

    expect(parts.u1?.map((part) => part.id)).toEqual(["u1:text:0", "u1:file:0", "u1:agent:0"])
    expect(parts.u1?.at(0)).toMatchObject({ type: "text", text: "hello" })
    expect(parts.u1?.at(1)).toMatchObject({ type: "file", filename: "notes.txt" })
    expect(parts.u1?.at(2)).toMatchObject({ type: "agent", name: "explore" })
  })

  test("promotes non-empty synthetic records to a synthetic text part", () => {
    const parts = contentParts(sessionID, [
      { id: "s1", type: "synthetic", sessionID, text: "notice", time: { created: 1 } },
      { id: "s2", type: "synthetic", sessionID, text: "   ", time: { created: 2 } },
    ])

    expect(parts.s1).toMatchObject([{ type: "text", text: "notice", synthetic: true }])
    expect(parts.s2).toBeUndefined()
  })

  test("renders a shell command as its user command plus assistant tool output", () => {
    const parts = contentParts(sessionID, [
      {
        id: "sh1",
        type: "shell",
        callID: "call_1",
        command: "bun test",
        output: "712 pass",
        time: { created: 1, completed: 2 },
      },
    ])

    expect(parts.sh1).toMatchObject([{ type: "text", text: "bun test" }])
    expect(parts["sh1:assistant"]).toMatchObject([
      {
        type: "tool",
        tool: "bash",
        callID: "call_1",
        messageID: "sh1:assistant",
        state: { status: "completed", output: "712 pass", title: "Shell", time: { start: 1, end: 2 } },
      },
    ])
  })

  test("keeps a running shell open", () => {
    const parts = contentParts(sessionID, [
      { id: "sh1", type: "shell", callID: "call_1", command: "bun test", output: "", time: { created: 1 } },
    ])

    expect(parts["sh1:assistant"]?.at(0)).toMatchObject({
      state: { status: "running", time: { start: 1 } },
    })
  })

  test("projects assistant text and reasoning with per-type ordinals and skips blank bodies", () => {
    const parts = contentParts(sessionID, [
      assistant("a1", [text("t1", "first"), reasoning("r1", "thinking"), text("t2", "  "), text("t3", "second")]),
    ])

    expect(parts.a1?.map((part) => part.id)).toEqual([
      sessionMessagePartID("a1", "text", 0),
      sessionMessagePartID("a1", "reasoning", 0),
      sessionMessagePartID("a1", "text", 2),
    ])
    expect(parts.a1?.at(0)).toMatchObject({ type: "text", text: "first" })
    expect(parts.a1?.at(1)).toMatchObject({ type: "reasoning", text: "thinking" })
    expect(parts.a1?.at(2)).toMatchObject({ type: "text", text: "second" })
  })

  test("projects tool states", () => {
    const parts = contentParts(sessionID, [
      assistant("a1", [
        tool("call_1", "bash", { status: "pending", input: '{"command":"bun test"}' }),
        tool("call_2", "edit", {
          status: "running",
          input: { path: "src/a.ts" },
          structured: { files: [{ file: "src/a.ts", additions: 2, deletions: 1 }] },
          content: [],
        }),
        tool("call_3", "read", {
          status: "completed",
          input: { filePath: "src/a.ts" },
          structured: {},
          content: [{ type: "text", text: "contents" }],
        }),
        tool("call_4", "grep", {
          status: "error",
          input: { pattern: "x" },
          structured: {},
          content: [],
          error: { type: "unknown", message: "no matches" },
        }),
      ]),
    ])

    const [pending, running, completed, failed] = parts.a1 ?? []
    expect(pending).toMatchObject({
      id: "call_1",
      tool: "bash",
      state: { status: "pending", input: { command: "bun test" }, raw: '{"command":"bun test"}' },
    })
    expect(running).toMatchObject({
      id: "call_2",
      tool: "edit",
      state: {
        status: "running",
        input: { path: "src/a.ts", filePath: "src/a.ts" },
        metadata: { filediff: { file: "src/a.ts", additions: 2, deletions: 1 } },
      },
    })
    expect(completed).toMatchObject({
      id: "call_3",
      state: { status: "completed", output: "contents", title: "read" },
    })
    expect(failed).toMatchObject({
      id: "call_4",
      state: { status: "error", error: "no matches" },
    })
  })

  test("attaches compaction markers to the open turn's user message", () => {
    const parts = contentParts(sessionID, [
      user("u1"),
      assistant("a1", [text("t1", "answer")]),
      { id: "c1", type: "compaction", reason: "auto", summary: "s", recent: "r", time: { created: 3 } },
      user("u2"),
    ])

    expect(parts.u1?.at(-1)).toMatchObject({ type: "compaction", auto: true, messageID: "u1" })
    expect(parts.u2).toMatchObject([{ type: "text" }])
  })

  test("creates reactive content with stable references for unchanged parts", () => {
    createRoot((dispose) => {
      const [records, setRecords] = createStore<SessionMessageInfo[]>([user("u1"), assistant("a1", [text("t1", "first")])])
      const content = createSessionContent(
        () => "ses_content",
        () => records,
      )

      const before = unwrap(content("a1") ?? [])[0]
      expect(before).toMatchObject({ type: "text", text: "first" })

      setRecords(1, assistant("a1", [text("t1", "first"), text("t2", "second")]))

      const after = unwrap(content("a1") ?? [])
      expect(after).toHaveLength(2)
      expect(after[0]).toBe(before)
      expect(after[1]).toMatchObject({ type: "text", text: "second" })

      dispose()
    })
  })
})
