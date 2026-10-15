import { expect, test } from "bun:test"
import { readTranscript } from "@/engine/transcript"
import { messageID } from "@/engine/identity"
import { AbsolutePath } from "@miao/schema/schema"

const session = "ses_transcript"
const location = { directory: AbsolutePath.make("/tmp/native-transcript") }
const row = (seq: number, kind: string, data: object) => ({
  session_id: session,
  seq,
  kind,
  data,
  recorded_at_ms: 1000 + seq,
})
const journal = [
  row(1, "input.admitted", { input_id: "msg_client_prompt", prompt: "initial task", delivery: "steer" }),
  row(2, "input.promoted", { input_id: "msg_client_prompt", prompt: "initial task", checkpoint: "cp" }),
  row(3, "provider.started", { run_id: "r", step: 0 }),
  row(4, "usage", { run_id: "r", step: 0, usage: { inputTokens: 30, outputTokens: 5 } }),
  row(5, "message.committed", { role: "assistant", anchor_seq: 3, content: [{ type: "text", text: "native answer" }] }),
  row(6, "assistant.identity", {
    anchor_seq: 3,
    assistant_seq: 5,
    agent: null,
    provider: { protocol: "openai-chat", model: "fixture" },
  }),
]
const visible = [
  { seq: 2, role: "user" },
  { seq: 5, role: "assistant", identity: { anchor_seq: 3 } },
]

function request(snapshot: object, events = journal) {
  return async (method: string, params: { after?: number }) => {
    if (method === "snapshot") return snapshot
    if (method === "events") return events.filter((event) => event.seq > (params.after ?? 0)).slice(0, 2)
    throw new Error(`unexpected native method ${method}`)
  }
}

test("native transcript keeps client IDs, assistant anchors and billed usage", async () => {
  const messages = await readTranscript({
    sessionID: session,
    engineID: "store",
    location,
    selected: true,
    request: request({ session_id: session, cursor: 6, messages: visible, selection: null }),
  })
  expect(messages.map((message) => String(message.id))).toEqual(["msg_client_prompt", messageID(session, 3)])
  const user = messages[0]
  if (user.type !== "user") throw new Error("first message must be the promoted prompt")
  expect(user.text).toBe("initial task")
  const assistant = messages[1]
  if (assistant.type !== "assistant") throw new Error("second message must be the native answer")
  expect(assistant.content).toHaveLength(1)
  expect(assistant.content[0]).toMatchObject({ type: "text", text: "native answer" })
  expect(assistant.tokens?.input).toBe(30)
  expect(assistant.tokens?.output).toBe(5)
})

test("the selected context applies the atomic cut without hiding raw timeline messages", async () => {
  const events = [
    ...journal,
    row(7, "history.compacted", { through_message_seq: 5, summary: "completed initial task" }),
    row(8, "input.admitted", { input_id: "msg_after_cut", prompt: "continue", delivery: "steer" }),
    row(9, "input.promoted", { input_id: "msg_after_cut", prompt: "continue", checkpoint: "next" }),
  ]
  const snapshot = {
    session_id: session,
    cursor: 9,
    messages: [...visible, { seq: 9, role: "user" }],
    selection: { through_seq: 5, seq: 7, summary: "completed initial task", recorded_at_ms: 1007 },
  }
  const selected = await readTranscript({
    sessionID: session,
    engineID: "store",
    location,
    selected: true,
    request: request(snapshot, events),
  })
  expect(selected.map((message) => message.type)).toEqual(["system", "user"])
  expect(selected[0].id).toBe(messageID(session, 7))
  const summary = selected[0]
  if (summary.type !== "system") throw new Error("native checkpoint summary must be explicit")
  expect(summary.text).toContain("completed initial task")
  const all = await readTranscript({
    sessionID: session,
    engineID: "store",
    location,
    selected: false,
    request: request(snapshot, events),
  })
  expect(all.map((message) => String(message.id))).toEqual([
    "msg_client_prompt",
    messageID(session, 3),
    "msg_after_cut",
  ])
})

test("reverted messages do not reappear from their old journal events", async () => {
  const messages = await readTranscript({
    sessionID: session,
    engineID: "store",
    location,
    selected: false,
    request: request({ session_id: session, cursor: 6, messages: [], selection: null }),
  })
  expect(messages).toEqual([])
})

test("replay uses the captured snapshot even when the native journal advances", async () => {
  let reads = 0
  const events = [
    ...journal,
    row(7, "message.committed", { role: "user", input_id: "msg_future", content: [{ type: "text", text: "future" }] }),
  ]
  const messages = await readTranscript({
    sessionID: session,
    engineID: "store",
    location,
    selected: false,
    request: async (method, params) => {
      if (method === "snapshot") {
        reads++
        return { session_id: session, cursor: reads === 1 ? 6 : 7, messages: visible, selection: null }
      }
      return events.filter((event) => event.seq > (params.after ?? 0))
    },
  })
  expect(reads).toBe(1)
  expect(messages.map((message) => message.id)).not.toContain("msg_future")
})

test("a snapshot without provenance/selection fails rather than returning TS history", async () => {
  await expect(
    readTranscript({
      sessionID: session,
      engineID: "store",
      location,
      selected: true,
      request: async () => ({ session_id: session, cursor: 0, messages: [] }),
    }),
  ).rejects.toThrow()
})
