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
