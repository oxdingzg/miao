import { expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@miao/schema/session-id"
import { SessionMessage } from "@miao/schema/session-message"
import { EngineClient } from "../../src/engine/client"
import { EngineSession, type EngineSessionEvent } from "../../src/engine/session"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

;(binary ? test : test.skip)(
  "image-only product input reaches the provider and survives replay, fork and exact retry",
  async () => {
    await using tmp = await tmpdir()
    const requests: unknown[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.json())
        return new Response(
          [
            { choices: [{ index: 0, delta: { content: "image received" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const options = {
      binary: binary ?? "",
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      provider: "openai-chat",
      endpoint: server.url.toString(),
      model: "fixture",
      env: { ...process.env, OPENAI_API_KEY: "fixture-only" },
    }
    const sessionID = SessionID.descending("ses_product_image")
    const id = SessionMessage.ID.create()
    const file = {
      uri: `data:image/png;base64,${png}`,
      name: "diagram.png",
      path: "/client/diagram.png",
      source: { start: 0, end: 7, text: "diagram" },
    }
    const files = [{ ...file, mime: "image/png" }]
    const input = { sessionID, id, prompt: { text: "", files: [file] } }
    const events: EngineSessionEvent[] = []
    const client = EngineClient.start(options)
    try {
      const facade = new EngineSession(client, (event) => events.push(event))
      const receipt = await facade.promptProduct(input)
      expect(receipt.prompt).toEqual({ text: "", files })
      for (let i = 0; i < 500 && !events.some((event) => event.type === "session.next.step.ended"); i++)
        await Bun.sleep(10)
      expect(
        events.filter((event) => event.type === "session.next.prompted").map((event) => event.data),
      ).toContainEqual(expect.objectContaining({ prompt: { text: "", files } }))
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([{ type: "image_url", image_url: { url: file.uri } }]),
          }),
        ]),
      })
      expect(await facade.promptProduct({ ...input, resume: false })).toEqual(receipt)
      await expect(
        facade.promptProduct({
          ...input,
          resume: false,
          prompt: { text: "", files: [{ ...file, name: "changed.png" }] },
        }),
      ).rejects.toMatchObject({ code: "input_conflict" })
      const forkID = SessionID.descending("ses_product_image_fork")
      await client.request("fork", { session_id: sessionID, target_session_id: forkID })
      await facade.restore(forkID)
      expect(
        events.filter((event) => event.type === "session.next.prompted").map((event) => event.data),
      ).toContainEqual(expect.objectContaining({ sessionID: forkID, prompt: { text: "", files } }))
    } finally {
      await client.close()
      server.stop(true)
    }
    const replayed: EngineSessionEvent[] = []
    const reopened = EngineClient.start(options)
    try {
      await new EngineSession(reopened, (event) => replayed.push(event)).restore(sessionID)
      expect(
        replayed.filter((event) => event.type === "session.next.prompted").map((event) => event.data),
      ).toContainEqual(expect.objectContaining({ prompt: { text: "", files } }))
    } finally {
      await reopened.close()
    }
  },
  30_000,
)
