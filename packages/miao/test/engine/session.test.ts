import { expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { EngineClient } from "@/engine/client"
import { EngineSession, type EngineSessionEvent } from "@/engine/session"

const fake = path.join(import.meta.dir, "..", "fixture", "engine-fake.ts")
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "miao-engine-session-"))

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("EngineSession publishes bridged product events for a prompt", async () => {
  const root = await tmp()
  const client = EngineClient.start({
    binary: fake,
    db: path.join(root, "engine.db"),
    workspace: root,
    model: "test",
    provider: "openai-chat",
  })
  const events: EngineSessionEvent[] = []
  const session = new EngineSession(client, (event) => events.push(event))
  try {
    await session.prompt("ses_x", "hi")
    await waitFor(() => JSON.stringify(events).includes('"type":"idle"'))
    const types = events.map((event) => event.type)
    expect(types).toContain("session.next.status")
    expect(types).toContain("session.next.text.ended")
    expect(JSON.stringify(events)).toContain("echo:hi")
    expect(JSON.stringify(events)).toContain('"type":"busy"')
    expect(events.find((event) => event.type === "session.next.text.ended")?.source).toEqual({
      sessionID: "ses_x",
      seq: 4,
      index: 0,
      recordedAtMs: 1_700_000_000_123,
    })
    expect(events.find((event) => event.type === "session.next.status")?.source.recordedAtMs).toBeNull()
  } finally {
    await client.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each(["failed", "interrupted", "completed"])(
  "late progress cannot reopen committed or %s parts and later steps still stream",
  async (reason) => {
    const root = await tmp()
    const client = EngineClient.start({
      binary: fake,
      db: path.join(root, "engine.db"),
      workspace: root,
      model: "test",
    })
    const outputs: EngineSessionEvent[] = []
    new EngineSession(client, (event) => outputs.push(event))
    const progress = (anchor: number, text: string, session = "ses_boundary") => ({
      method: "progress",
      params: {
        session_id: session,
        run_id: "run",
        step: anchor,
        kind: "provider.delta",
        anchor_seq: anchor,
        recorded_at_ms: 1_700_000_000_123,
        data: { kind: "delta", delta: { kind: "text.delta", text } },
      },
    })
    const event = (seq: number, kind: string, data: unknown) => ({
      method: "event",
      params: { session_id: "ses_boundary", seq, kind, data, recorded_at_ms: 1_700_000_000_123 },
    })
    try {
      await client.request("fixture_frames", {
        frames: [
          progress(1, "live"),
          event(3, "message.committed", {
            role: "assistant",
            anchor_seq: 1,
            content: [{ type: "text", text: "live" }],
          }),
          progress(1, "late-after-commit"),
          progress(5, "next-step"),
          event(7, "run.finished", { run_id: "run", reason }),
          progress(5, "late-after-failure"),
          event(5, "provider.started", { run_id: "run", step: 5 }),
          progress(5, "late-after-replayed-start"),
          progress(10, "later-run"),
          progress(1, "other-session", "ses_other"),
        ],
      })
      const discarded = outputs.filter((event) => event.type === "session.next.stream.discarded")
      expect(discarded).toHaveLength(1)
      expect(discarded[0]?.data).toMatchObject({ assistantMessageID: "msg_ses_boundary_5" })
      expect(discarded[0]?.source).toMatchObject({ seq: 5, index: 1 })
      expect(
        outputs
          .filter((event) => event.type === "session.next.status" && event.source.seq === 7)
          .map((event) => event.source.index),
      ).toEqual([0])
      const fragments = outputs.filter((event) => event.type === "session.next.text.delta")
      expect(
        fragments.map((event) => {
          if (typeof event.data !== "object" || event.data === null || !("delta" in event.data))
            throw new Error("missing text delta")
          return event.data.delta
        }),
      ).toEqual(["live", "next-step", "later-run", "other-session"])
    } finally {
      await client.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test("native fragments translate into reasoning, tool, and indexed text events", async () => {
  const root = await tmp()
  const client = EngineClient.start({
    binary: fake,
    db: path.join(root, "engine.db"),
    workspace: root,
    model: "test",
  })
  const outputs: EngineSessionEvent[] = []
  new EngineSession(client, (event) => outputs.push(event))
  const progress = (anchor: number, delta: unknown) => ({
    method: "progress",
    params: {
      session_id: "ses_fragments",
      run_id: "run",
      step: anchor,
      kind: "provider.delta",
      anchor_seq: anchor,
      recorded_at_ms: 1_700_000_000_123,
      data: { kind: "delta", delta },
    },
  })
  try {
    await client.request("fixture_frames", {
      frames: [
        progress(1, { kind: "text.delta", index: 0, text: "hello" }),
        progress(1, { kind: "reasoning.delta", index: 1, text: "thinking" }),
        progress(1, { kind: "tool.start", index: 2, id: "call_1", name: "read_file" }),
        progress(1, { kind: "tool.input.delta", index: 2, delta: '{"p":1' }),
        progress(1, { kind: "text.delta", index: 3, text: "again" }),
        progress(1, { kind: "reasoning.delta", text: "free" }),
        progress(1, { kind: "tool.input.delta", index: 9, delta: "orphan" }),
      ],
    })
    await waitFor(() => outputs.length >= 6)
    const by = (type: string) => outputs.filter((event) => event.type === type)
    const text = by("session.next.text.delta")
    expect(
      text.map((event) => {
        const data = event.data as { textID: string; delta: string }
        return [data.textID, data.delta]
      }),
    ).toEqual([
      ["text_1_0", "hello"],
      ["text_1_1", "again"],
    ])
    const reasoning = by("session.next.reasoning.delta")
    expect(
      reasoning.map((event) => {
        const data = event.data as { reasoningID: string; delta: string }
        return [data.reasoningID, data.delta]
      }),
    ).toEqual([
      ["reasoning_1_0", "thinking"],
      ["reasoning_1_1", "free"],
    ])
    const started = by("session.next.tool.input.started")
    expect(started).toHaveLength(1)
    expect(started[0]?.data).toMatchObject({ callID: "call_1", name: "read_file" })
    const input = by("session.next.tool.input.delta")
    expect(
      input.map((event) => {
        const data = event.data as { callID: string; delta: string }
        return [data.callID, data.delta]
      }),
    ).toEqual([["call_1", '{"p":1']])
    const streamed = outputs.filter((event) => event.type.startsWith("session.next."))
    expect(streamed.map((event) => event.source?.index)).toEqual([0, 1, 2, 3, 4, 5])
  } finally {
    await client.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
