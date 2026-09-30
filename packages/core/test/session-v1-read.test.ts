import { describe, expect, test } from "bun:test"
import { RelativePath } from "@miao/core/schema"
import { SessionMessage } from "@miao/core/session/message"
import { SessionV1Read } from "@miao/core/session/v1-read"
import { Schema } from "effect"

const sessionID = "ses_x"
const messageID = "msg_a"
const directory = "/work/project"

const base = { sessionID, messageID }

const user = (text: string) => ({
  info: {
    id: "msg_u",
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  },
  parts: [{ ...base, id: "prt_1", type: "text", text }],
})

const assistant = (parts: ReadonlyArray<Record<string, unknown>>) => ({
  info: {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 2, completed: 4 },
    parentID: "msg_u",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0.01,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  },
  parts,
})

const text = (value: string) => ({ ...base, id: "prt_text", type: "text", text: value })
const stepStart = (snapshot: string) => ({ ...base, id: "prt_start", type: "step-start", snapshot })
const stepFinish = (snapshot: string) => ({
  ...base,
  id: "prt_finish",
  type: "step-finish",
  reason: "stop",
  snapshot,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const patch = (hash: string, files: string[]) => ({ ...base, id: "prt_patch", type: "patch", hash, files })
const bash = (metadata: Record<string, unknown>) => ({
  ...base,
  id: "prt_tool",
  type: "tool",
  callID: "c1",
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "ls" },
    output: "out",
    title: "t",
    metadata,
    time: { start: 2, end: 3 },
  },
})

const paths = (files: string[]) => files.map((file) => RelativePath.make(file))

const first = (messages: ReturnType<typeof assistant>[]) =>
  SessionV1Read.map(messages as never, { directory })[0] as SessionMessage.Assistant

describe("SessionV1Read.map", () => {
  test("maps legacy user and assistant messages to V2 shapes", () => {
    const messages = SessionV1Read.map(
      [user("hello") as never, assistant([text("hi"), bash({})]) as never],
      { directory },
    )
    expect(messages[0]).toMatchObject({ type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      type: "assistant",
      agent: "build",
      finish: "stop",
      content: [
        { type: "text", text: "hi" },
        { type: "tool", name: "bash", state: { status: "completed", content: [{ type: "text", text: "out" }] } },
      ],
    })
  })

  // A legacy assistant message records its span as per-step trees. `patch.hash`
  // is the tree the step started from, so `end` can only come from step-finish.
  test("builds snapshot start, end, and project-relative files from step markers and patches", () => {
    const message = first([
      assistant([stepStart("tree-a"), text("hi"), stepFinish("tree-b"), patch("tree-a", [`${directory}/a.ts`])]),
    ])
    expect(message.snapshot).toEqual({ start: "tree-a", end: "tree-b", files: paths(["a.ts"]) })
  })

  test("falls back to the first patch hash and unions files across patches", () => {
    const message = first([
      assistant([
        patch("tree-a", [`${directory}/a.ts`, `${directory}/b.ts`]),
        patch("tree-a", [`${directory}/b.ts`, `${directory}/c.ts`]),
      ]),
    ])
    expect(message.snapshot).toEqual({ start: "tree-a", files: paths(["a.ts", "b.ts", "c.ts"]) })
  })

  // Absolute paths would make a later revert resolve against the wrong root, so
  // a mapping that cannot place them omits them entirely.
  test("omits snapshot files when no project root is known", () => {
    const message = SessionV1Read.map([
      assistant([stepStart("tree-a"), stepFinish("tree-b"), patch("tree-a", [`${directory}/a.ts`])]),
    ] as never) as unknown as SessionMessage.Assistant[]
    expect(message[0]!.snapshot).toEqual({ start: "tree-a", end: "tree-b" })
  })

  test("omits the snapshot when the message changed nothing", () => {
    const message = first([assistant([text("hi"), bash({})])])
    expect(message.snapshot).toBeUndefined()
  })

  test("keeps tool metadata as structured without repeating the output", () => {
    const message = first([
      assistant([bash({ output: "out", exit: 0, truncated: false })]),
    ]) as unknown as { content: { state: { structured: Record<string, unknown> } }[] }
    expect(message.content[0]!.state.structured).toEqual({ exit: 0, truncated: false })
  })

  test("keeps a metadata output that differs from the recorded output", () => {
    const message = first([
      assistant([bash({ output: "full output", exit: 0 })]),
    ]) as unknown as { content: { state: { structured: Record<string, unknown> } }[] }
    expect(message.content[0]!.state.structured).toEqual({ output: "full output", exit: 0 })
  })

  test("maps tool attachments", () => {
    const attachment = { ...base, id: "prt_file", type: "file", mime: "image/png", url: "data:image/png;base64,AA" }
    const tool = bash({})
    const message = SessionV1Read.map([
      assistant([{ ...tool, state: { ...tool.state, attachments: [attachment] } }]),
    ] as never) as unknown as SessionMessage.Assistant[]
    expect(message[0]!.content[0]).toMatchObject({ state: { attachments: [{ uri: attachment.url, mime: "image/png" }] } })
  })

  // The projected shape is what a backfill writes, so every mapped message must
  // survive the schema the projection is read back with.
  test("encodes every message in the projected schema", () => {
    const encode = Schema.encodeSync(SessionMessage.Message)
    const messages = SessionV1Read.map(
      [
        user("hello"),
        assistant([stepStart("tree-a"), text("hi"), stepFinish("tree-b"), patch("tree-a", [`${directory}/a.ts`])]),
        assistant([bash({ output: "out", exit: 0 }), text("bye")]),
      ] as never,
      { directory },
    )
    for (const message of messages) expect(encode(message)).toMatchObject({ id: message.id, type: message.type })
  })
})
