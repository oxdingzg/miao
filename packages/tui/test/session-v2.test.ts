import { expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessage } from "@miao/sdk/v2"
import {
  isLiveSessionV2Event,
  isV2StreamFragmentEvent,
  mergeTranscript,
  sessionContextToMessages,
} from "../src/context/session-v2"
import { promptInputFromParts } from "../src/context/session-v2-write"
import { sessionInfo } from "../src/context/session-v2-read"

const base = { sessionID: "ses_1", cwd: "/work", root: "/work" }

test("maps a user message into a user info plus a text part", () => {
  const messages: SessionMessage[] = [
    {
      id: "msg_u",
      type: "user",
      time: { created: 10 },
      text: "hello",
      files: [{ uri: "file:///a.png", mime: "image/png", name: "a.png" }],
    },
  ]
  const [mapped] = sessionContextToMessages({ ...base, messages })
  expect(mapped.info.role).toBe("user")
  expect(mapped.info.id).toBe("msg_u")
  expect(mapped.parts.map((part) => part.type)).toEqual(["text", "file"])
  expect(mapped.parts[0]).toMatchObject({ type: "text", text: "hello" })
})

test("maps assistant content and links parentID to the preceding user", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "hi" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20, completed: 30 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        { type: "reasoning", id: "prt_r", text: "think" },
        { type: "text", id: "prt_t", text: "answer" },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  expect(assistant.info.role).toBe("assistant")
  if (assistant.info.role !== "assistant") throw new Error("expected assistant")
  expect(assistant.info.parentID).toBe("msg_u")
  expect(assistant.info.modelID).toBe("gpt")
  expect(assistant.parts.map((part) => part.type)).toEqual(["reasoning", "text"])
})

test("maps a completed tool state to V1 output/title", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "run" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        {
          type: "tool",
          id: "prt_tool",
          name: "bash",
          time: { created: 20, ran: 21, completed: 22 },
          state: {
            status: "completed",
            input: { command: "ls" },
            structured: {},
            content: [{ type: "text", text: "ok" }],
          },
        },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  const part = assistant.parts[0]
  if (part.type !== "tool") throw new Error("expected tool part")
  expect(part.tool).toBe("bash")
  expect(part.state).toMatchObject({ status: "completed", output: "ok", title: "bash" })
})

test("projects V2 file tool input onto the V1 filePath the renderers read", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "change it" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        {
          type: "tool",
          id: "prt_read",
          name: "read",
          time: { created: 20, ran: 21, completed: 22 },
          state: { status: "completed", input: { path: "a.ts" }, structured: {}, content: [] },
        },
        {
          type: "tool",
          id: "prt_write",
          name: "write",
          time: { created: 20, ran: 21, completed: 22 },
          state: { status: "completed", input: { path: "b.ts", content: "x" }, structured: {}, content: [] },
        },
        {
          type: "tool",
          id: "prt_edit",
          name: "edit",
          time: { created: 20, ran: 21, completed: 22 },
          state: {
            status: "completed",
            input: { path: "c.ts", oldString: "a", newString: "b" },
            structured: {
              files: [{ file: "c.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" }],
              replacements: 1,
            },
            content: [{ type: "text", text: "Edited c.ts" }],
          },
        },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  const [read, write, edit] = assistant.parts
  if (read.type !== "tool" || write.type !== "tool" || edit.type !== "tool") throw new Error("expected tool parts")
  expect(read.state.input).toMatchObject({ path: "a.ts", filePath: "a.ts" })
  expect(write.state.input).toMatchObject({ path: "b.ts", filePath: "b.ts", content: "x" })
  expect(edit.state.input).toMatchObject({ filePath: "c.ts" })
  expect(edit.state).toMatchObject({
    status: "completed",
    output: "Edited c.ts",
    metadata: { diff: "@@ -1 +1 @@\n-a\n+b\n", replacements: 1, output: "Edited c.ts" },
  })
})

test("projects V2 structured tool output onto the V1 metadata renderers read", () => {
  const messages: SessionMessage[] = [
    { id: "msg_u", type: "user", time: { created: 10 }, text: "go" },
    {
      id: "msg_a",
      type: "assistant",
      time: { created: 20 },
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
      content: [
        {
          type: "tool",
          id: "prt_patch",
          name: "apply_patch",
          time: { created: 20, ran: 21, completed: 22 },
          state: {
            status: "completed",
            input: { patchText: "*** Begin Patch" },
            structured: {
              applied: [],
              files: [
                { file: "d.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "added" },
                { file: "gone.ts", patch: "@@ -1,2 +0,0 @@\n-a\n-b\n", additions: 0, deletions: 2, status: "deleted" },
              ],
            },
            content: [],
          },
        },
        {
          type: "tool",
          id: "prt_task",
          name: "task",
          time: { created: 20, ran: 21, completed: 22 },
          state: {
            status: "completed",
            input: { description: "explore", prompt: "p", subagent_type: "explore" },
            structured: { sessionID: "ses_child", text: "done" },
            content: [],
          },
        },
      ],
    },
  ]
  const [, assistant] = sessionContextToMessages({ ...base, messages })
  const [patch, task] = assistant.parts
  if (patch.type !== "tool" || task.type !== "tool") throw new Error("expected tool parts")
  expect(patch.state.status === "completed" && patch.state.metadata).toMatchObject({
    files: [
      {
        type: "add",
        relativePath: "d.ts",
        filePath: "d.ts",
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        deletions: 1,
      },
      // The transcript renders a deleted file from this patch, so the removal diff
      // has to survive projection instead of collapsing to a line count.
      {
        type: "delete",
        relativePath: "gone.ts",
        filePath: "gone.ts",
        patch: "@@ -1,2 +0,0 @@\n-a\n-b\n",
        deletions: 2,
      },
    ],
  })
  expect(task.state.status === "completed" && task.state.metadata).toMatchObject({
    sessionID: "ses_child",
    sessionId: "ses_child",
  })
})

test("merges the active context with the older projected timeline", () => {
  const user = (id: string, created: number, text: string): SessionMessage => ({
    id,
    type: "user",
    time: { created },
    text,
  })
  const active = [user("msg_3", 30, "after compaction")]
  const history = [
    user("msg_2", 20, "pruned copy"),
    user("msg_3", 30, "stale copy"),
    user("msg_1", 10, "before compaction"),
  ]
  const merged = mergeTranscript(active, history)
  expect(merged.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"])
  expect(merged.find((message) => message.id === "msg_3")).toMatchObject({ text: "after compaction" })
})

test("skips V2 meta messages", () => {
  const messages: SessionMessage[] = [
    { id: "msg_s", type: "agent-switched", time: { created: 1 }, agent: "build" },
    { id: "msg_c", type: "compaction", time: { created: 2 }, reason: "auto", summary: "s", recent: "r" },
    { id: "msg_u", type: "user", time: { created: 3 }, text: "hi" },
  ]
  const mapped = sessionContextToMessages({ ...base, messages })
  expect(mapped.map((entry) => entry.info.id)).toEqual(["msg_u"])
})

test("classifies live V2 session events for transcript refresh", () => {
  expect(isLiveSessionV2Event("session.next.text.delta")).toBe(true)
  expect(isLiveSessionV2Event("session.next.step.ended")).toBe(true)
  expect(isLiveSessionV2Event("session.next.moved")).toBe(false)
  expect(isLiveSessionV2Event("message.part.updated")).toBe(false)
})

test("applies stream fragments incrementally instead of re-hydrating", () => {
  expect(isV2StreamFragmentEvent("session.next.text.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.reasoning.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.tool.input.delta")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.tool.progress")).toBe(true)
  expect(isV2StreamFragmentEvent("session.next.text.ended")).toBe(false)
  expect(isV2StreamFragmentEvent("session.next.tool.called")).toBe(false)
  expect(isV2StreamFragmentEvent("session.next.step.ended")).toBe(false)
})

test("maps prompt parts into the V2 prompt input", () => {
  expect(promptInputFromParts([{ type: "text", text: "hi" }])).toEqual({ text: "hi" })
  expect(
    promptInputFromParts([
      { type: "text", text: "hi" },
      { type: "file", url: "file:///a.png", filename: "a.png" },
    ]),
  ).toEqual({ text: "hi", files: [{ uri: "file:///a.png", name: "a.png" }] })
  const pdf = "data:application/pdf;base64,JVBERi0="
  const local = path.resolve("report.pdf")
  expect(
    promptInputFromParts([
      { type: "text", text: "[PDF 1]" },
      { type: "file", url: pdf, filename: "report.pdf", source: { type: "file", path: local } },
      // A clipboard paste has no file on disk; its source path falls back to the bare filename.
      { type: "file", url: pdf, filename: "clip.pdf", source: { type: "file", path: "clip.pdf" } },
    ]),
  ).toEqual({
    text: "[PDF 1]",
    files: [
      { uri: pdf, name: "report.pdf", path: local },
      { uri: pdf, name: "clip.pdf" },
    ],
  })
  expect(
    promptInputFromParts([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
  ).toEqual({ text: "a\n\nb" })
})

test("maps a V2 session into the V1 session shape", () => {
  const mapped = sessionInfo({
    id: "ses_1",
    projectID: "prj_1",
    title: "t",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: "/work", workspaceID: "ws_1" },
    subpath: "sub",
  })
  expect(mapped).toMatchObject({
    id: "ses_1",
    slug: "ses_1",
    projectID: "prj_1",
    directory: "/work",
    workspaceID: "ws_1",
    path: "sub",
    version: "",
  })
})
