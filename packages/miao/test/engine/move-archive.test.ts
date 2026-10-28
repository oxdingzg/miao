import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AbsolutePath } from "@miao/schema/schema"
import { moveEngine } from "../../src/engine/transfer"
import { messageID } from "../../src/engine/identity"
import { tmpdir } from "../fixture/fixture"

for (const outcome of ["stable", "changed", "pending"] as const)
  test(`native move archives the source projection with outcome=${outcome}`, async () => {
    await using tmp = await tmpdir()
    const sessionID = "ses_move_archive"
    const file = AbsolutePath.make(path.join(tmp.path, "bundle.json"))
    const bundle = {
      format: "miao.session.transfer.v1",
      source: { engine: "rust", sequence: 6 },
      timeline: [
        { id: "msg_2", role: "user", content: [{ type: "text", text: "initial task" }] },
        { id: "msg_5", role: "assistant", content: [{ type: "text", text: "native answer" }] },
      ],
    }
    const events = [
      {
        seq: 1,
        kind: "input.admitted",
        data: { input_id: "msg_original_prompt", prompt: "initial task", delivery: "steer" },
      },
      {
        seq: 2,
        kind: "input.promoted",
        data: { input_id: "msg_original_prompt", prompt: "initial task", checkpoint: "cp" },
      },
      { seq: 3, kind: "provider.started", data: { run_id: "r", step: 0 } },
      { seq: 4, kind: "usage", data: { run_id: "r", step: 0, usage: { inputTokens: 30, outputTokens: 5 } } },
      {
        seq: 5,
        kind: "message.committed",
        data: { role: "assistant", anchor_seq: 3, content: [{ type: "text", text: "native answer" }] },
      },
      {
        seq: 6,
        kind: "assistant.identity",
        data: { anchor_seq: 3, assistant_seq: 5, agent: null, provider: { protocol: "openai-chat", model: "fixture" } },
      },
    ].map((event) => ({ ...event, session_id: sessionID, recorded_at_ms: 1000 + event.seq }))
    const host = moveEngine(
      {
        async request(method, params) {
          if (method === "transfer_export_move") {
            await Bun.write(file, JSON.stringify(bundle))
            return {
              session_id: sessionID,
              bundle_sha256: "original-digest",
              binding: { protocol: "openai-chat", model: "fixture" },
            }
          }
          if (method === "snapshot")
            return {
              session_id: sessionID,
              cursor: outcome === "changed" ? 7 : 6,
              pending: outcome === "pending" ? [{ input_id: "queued" }] : [],
              selection: null,
              messages: [
                { seq: 2, role: "user" },
                { seq: 5, role: "assistant", identity: { anchor_seq: 3 } },
              ],
            }
          if (method === "events") {
            const after = (params as { after?: number }).after ?? 0
            return events.filter((event) => event.seq > after).slice(0, 2)
          }
          throw new Error(`unexpected method ${method}`)
        },
      },
      { storage: "source", location: { directory: AbsolutePath.make(tmp.path) } },
    )
    const operation = Effect.runPromise(
      host.exportMove({
        sessionID,
        productDatabase: AbsolutePath.make(path.join(tmp.path, "product.db")),
        targetDirectory: AbsolutePath.make(tmp.path),
        bundleFile: file,
      }),
    )
    if (outcome !== "stable") {
      await expect(operation).rejects.toThrow(
        outcome === "changed" ? "Native Session changed during move export" : "Native Session has pending inputs",
      )
      expect(await Bun.file(file).json()).toEqual(bundle)
      return
    }
    const receipt = await operation
    const archive = await Bun.file(file).json()
    expect(archive.timeline).toEqual(bundle.timeline)
    expect(archive.display_timeline).toMatchObject([
      { id: "msg_original_prompt", type: "user", text: "initial task" },
      {
        id: messageID(sessionID, 3),
        type: "assistant",
        content: [{ type: "text", text: "native answer" }],
        tokens: { input: 30, output: 5 },
      },
    ])
    expect(archive.display_context_ids).toEqual(["msg_original_prompt", messageID(sessionID, 3)])
    expect(archive.display_sources).toEqual({ msg_original_prompt: "msg_2", [messageID(sessionID, 3)]: "msg_5" })
    expect(receipt.bundle_sha256).toBe(new Bun.CryptoHasher("sha256").update(await Bun.file(file).text()).digest("hex"))
    expect(receipt.bundle_sha256).not.toBe("original-digest")
  })
