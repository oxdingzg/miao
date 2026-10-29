import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Schema } from "effect"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN
const Pending = Schema.Struct({
  id: Schema.String,
  input_hash: Schema.String,
  authority_revision: Schema.String,
  state: Schema.String,
})
const failure = (value: Promise<unknown>) =>
  value.then(
    () => undefined,
    (error: unknown) => error,
  )

test.skipIf(!binary)(
  "a superseded execution claim cannot evaluate, admit or persist an always reply over stdio",
  async () => {
    if (!binary) throw new Error("native engine required")
    expect(capabilities(binary)?.schema ?? 0).toBeGreaterThanOrEqual(22)
    await using tmp = await tmpdir()
    const db = path.join(tmp.path, "engine.db")
    const policyFile = path.join(tmp.path, "policy.json")
    const productToolsFile = path.join(tmp.path, "tools.json")
    await Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] }))
    await Bun.write(
      productToolsFile,
      JSON.stringify({
        tools: [
          {
            name: "host_probe",
            description: "Source lease fixture",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    )
    const calls: string[] = []
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls.push("provider")
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "host-call", type: "function", function: { name: "host_probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const ready = Promise.withResolvers<{
      source: { session_id: string; bridge_id: number; call_id: string; message_seq: number }
      pending: typeof Pending.Type
    }>()
    const release = Promise.withResolvers<void>()
    const client: EngineClient = EngineClient.start({
      binary,
      db,
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
      policyFile,
      productToolsFile,
      async onProductTool(call) {
        try {
          if (call.messageSeq === undefined) throw new Error("missing real source")
          const source = {
            session_id: call.sessionID,
            bridge_id: call.bridgeID,
            call_id: call.callID,
            message_seq: call.messageSeq,
          }
          const pending = Schema.decodeUnknownSync(Pending)(
            await client.request("product_permission_admit", {
              source,
              input: {
                request_id: "lease-bound",
                facts: { actions: ["read"], resources: ["public"] },
                save: ["public"],
              },
            }),
          )
          ready.resolve({ source, pending })
          await release.promise
          return {}
        } catch (error) {
          ready.reject(error)
          throw error
        }
      },
    })
    try {
      await client.admit({ session_id: "s", input_id: "one", prompt: "call host", delivery: "steer" }, false)
      await client.request("select_agent", {
        session_id: "s",
        agent: {
          name: "fixture",
          ordered_permissions: {
            semantics: "ordered-wildcard-v1",
            rules: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "ask" },
            ],
          },
        },
      })
      await client.request("resume", { session_id: "s" })
      const parked = await Promise.race([
        ready.promise,
        Bun.sleep(10_000).then(() => {
          throw new Error("source fixture timed out")
        }),
      ])
      expect(parked.pending.state).toBe("pending")
      const database = new Database(db)
      try {
        const epoch = Schema.decodeUnknownSync(Schema.Struct({ captured: Schema.Number, current: Schema.Number }))(
          database
            .query(
              "SELECT r.lease_epoch AS captured,e.epoch AS current FROM engine_run r JOIN engine_lease e ON e.session_id=r.session_id WHERE r.session_id='s' AND r.state='running'",
            )
            .get(),
        )
        expect(epoch.captured).toBeGreaterThan(0)
        expect(epoch.captured).toBe(epoch.current)
        database.run("UPDATE engine_lease SET epoch=epoch+1 WHERE session_id='s'")
      } finally {
        database.close()
      }
      const facts = { actions: ["read"], resources: ["public"] }
      for (const request of [
        client.request("product_permission_evaluate", { source: parked.source, request: facts }),
        client.request("product_permission_admit", {
          source: parked.source,
          input: { request_id: "after-claim", facts, save: ["public"] },
        }),
        client.request("product_permission_reply", {
          source: parked.source,
          response: {
            request_id: parked.pending.id,
            input_hash: parked.pending.input_hash,
            authority_revision: parked.pending.authority_revision,
            reply: "always",
          },
        }),
      ].map(failure))
        expect(await request).toBeInstanceOf(Error)
      expect(await client.request("permission_pattern_list")).toEqual([])
      expect(calls).toEqual(["provider"])
    } finally {
      release.resolve()
      await client.close()
      await provider.stop(true)
    }
  },
  20_000,
)
