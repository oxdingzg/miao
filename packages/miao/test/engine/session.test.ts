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
      seq: 2,
      index: 0,
    })
  } finally {
    await client.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
