import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionEvent } from "@miao/schema/session-event"
import { AbsolutePath } from "@miao/schema/schema"
import { SessionMessageUpdater } from "@miao/core/session/message-updater"
import { translateContextPruned } from "@/engine/bridge"
import { replayJournal } from "@/engine/journal"
import { readTranscript } from "@/engine/transcript"
import { EngineClient } from "@/engine/client"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_context_settlement"
const location = { directory: AbsolutePath.make("/tmp/settlement") }
const pruned = {
  session_id: sessionID,
  seq: 1,
  kind: "context.pruned",
  recorded_at_ms: 1234,
  data: {
    run_id: "00000000-0000-4000-8000-000000000001",
    step: 2,
    context_epoch: 4,
    reason: "tool_output_budget",
    scope: "tool_result_payloads",
    unit: "utf8_bytes",
    payloads: 2,
    messages: 1,
    before_bytes: 8087,
    after_bytes: 2000,
    saved_bytes: 6087,
  },
}

test("pruning survives the public durable codec and reconnects with the same identity", async () => {
  const request = async (method: string) => (method === "snapshot" ? { session_id: sessionID, cursor: 1 } : [pruned])
  const input = { sessionID, location, engineID: "store", after: 0, request }
  const first = await replayJournal(input)
  const replay = await replayJournal(input)
  expect(first.events).toHaveLength(1)
  expect(first.events[0]).toEqual(replay.events[0])
  const event = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Durable))(first.events[0])
  if (event.type !== "session.next.context.pruned") throw new Error("missing pruning event")
  expect(event.data.pruning.savedBytes).toBe(6087)
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  await Effect.runPromise(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event))
  expect(state.messages).toEqual([])
})

test("invalid or unmeasured pruning never becomes a fabricated settlement", () => {
  expect(translateContextPruned({ ...pruned, recorded_at_ms: undefined })).toBeUndefined()
  for (const data of [
    { ...pruned.data, unit: "tokens" },
    { ...pruned.data, payloads: 0, messages: 0 },
    { ...pruned.data, saved_bytes: 999999 },
    { ...pruned.data, after_bytes: 9000, saved_bytes: -913 },
  ])
    expect(translateContextPruned({ ...pruned, data })).toBeUndefined()
})

test("settlement cards belong to the timeline and never become provider context", async () => {
  const journal = [
    pruned,
    {
      session_id: sessionID,
      seq: 2,
      kind: "history.compacted",
      recorded_at_ms: 2000,
      data: { compaction_id: "checkpoint", through_message_seq: 0, summary: "Remember the completed work" },
    },
  ]
  const request = async (method: string) =>
    method === "snapshot"
      ? {
          session_id: sessionID,
          cursor: 2,
          messages: [],
          selection: null,
        }
      : journal
  const input = { sessionID, location, engineID: "store", request }
  const timeline = await readTranscript({ ...input, selected: false })
  expect(timeline.map((message) => message.type)).toEqual(["synthetic", "compaction"])
  expect(timeline[0].metadata?.contextPruned).toMatchObject({ savedBytes: 6087, unit: "utf8_bytes" })
  expect(timeline[1].metadata?.throughMessageSeq).toBe(0)
  expect(await readTranscript({ ...input, selected: true })).toEqual([])
  expect(await readTranscript({ ...input, selected: false })).toEqual(timeline)
})

const binary = process.env.MIAO_ENGINE_BIN
test.skipIf(!binary)(
  "real native pruning replays measured facts while retaining recallable output",
  async () => {
    if (!binary) return
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await Bun.write(path.join(workspace, "large.txt"), "a".repeat(4000) + "MIDDLE_EVIDENCE_SENTINEL" + "z".repeat(4000))
    const requests: string[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(JSON.stringify(await request.json()))
        const tools = requests.length === 1
        const delta = tools
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "read-original",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "large.txt" }) },
                },
              ],
            }
          : { content: "done" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const client = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).href,
      env: { OPENAI_API_KEY: "fixture-only" },
      contextLimits: {
        window: 1_000_000,
        ratio: 0.9,
        headroom: 100_000,
        perPass: 1000,
        pruneChars: 2000,
        protectTurns: 0,
      },
    })
    const finished = Promise.withResolvers<void>()
    const timer = setTimeout(() => finished.reject(new Error("native pruning deadline exceeded")), 15_000)
    client.onEvent((event) => {
      if (event.kind === "run.finished") finished.resolve()
    })
    try {
      await client.request("initialize", { session_id: sessionID, title: "Pruning fixture" })
      await client.subscribe(sessionID)
      await client.admit({ session_id: sessionID, input_id: "msg_read_original", prompt: "Read large.txt and finish" })
      await finished.promise
      expect(requests).toHaveLength(2)
      expect(requests[1]).toContain("elided by context management")
      expect(requests[1]).not.toContain("MIDDLE_EVIDENCE_SENTINEL")
      const input = {
        sessionID,
        location,
        engineID: "store",
        request: (method: string, params: unknown) => client.request(method, params),
      }
      const page = await replayJournal({ ...input, after: 0 })
      const facts = page.events.filter((event) => event.type === "session.next.context.pruned")
      expect(facts).toHaveLength(1)
      if (facts[0].type !== "session.next.context.pruned") throw new Error("missing native facts")
      const value = facts[0].data.pruning
      expect(value.beforeBytes).toBeGreaterThan(8000)
      expect(value.beforeBytes - value.afterBytes).toBe(value.savedBytes)
      const timeline = await readTranscript({ ...input, selected: false })
      expect(timeline.filter((message) => message.metadata?.contextPruned)).toHaveLength(1)
      expect(
        (await readTranscript({ ...input, selected: true })).some((message) => message.metadata?.contextPruned),
      ).toBe(false)
      expect(JSON.stringify(await client.request("snapshot", { session_id: sessionID }))).toContain(
        "MIDDLE_EVIDENCE_SENTINEL",
      )
    } finally {
      clearTimeout(timer)
      await client.close()
      provider.stop(true)
    }
  },
  30_000,
)
