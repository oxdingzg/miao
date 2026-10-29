import { expect, test } from "bun:test"
import path from "node:path"
import { EngineClient, type EngineEvent } from "@/engine/client"
import { ProductPermissionRequest } from "@/engine/product-permission-request"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

type Source = { session_id: string; bridge_id: number; call_id: string; message_seq: number }
type Record = { id: string; input_hash: string; authority_revision: string; state: string }
const failure = (value: Promise<unknown>) =>
  value.then(
    () => undefined,
    (error: unknown) => error,
  )

test.skipIf(!binary)(
  "native host assertions preserve retry identity, atomic always rules and cancellation across stdio",
  async () => {
    if (!binary) throw new Error("native engine required")
    const capabilities: unknown = await Bun.$`${binary} --capabilities`.json()
    expect(capabilities).toMatchObject({
      product_permission_replies: 1,
      product_permission_cancel: 1,
      product_permission_diagnostics: 1,
    })
    await using tmp = await tmpdir()
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json()
        const first = !body.messages.some((message: { role: string }) => message.role === "tool")
        const delta = first
          ? {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "host-call", type: "function", function: { name: "host_probe", arguments: "{}" } },
              ],
            }
          : { content: "done" }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const policyFile = path.join(tmp.path, "policy.json")
    const productToolsFile = path.join(tmp.path, "tools.json")
    await Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] }))
    await Bun.write(
      productToolsFile,
      JSON.stringify({
        tools: [
          {
            name: "host_probe",
            description: "Permission assertion fixture",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
    )
    const parked = Promise.withResolvers<{ source: Source; pending: Record }>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const client: EngineClient = EngineClient.start({
      binary,
      db: path.join(tmp.path, "engine.db"),
      workspace: tmp.path,
      model: "fixture",
      provider: "openai-chat",
      endpoint: new URL("chat/completions", provider.url).toString(),
      env: { OPENAI_API_KEY: "fixture-only" },
      policyFile,
      productToolsFile,
      async onProductTool(call) {
        try {
          if (call.messageSeq === undefined) throw new Error("missing source message identity")
          const source = {
            session_id: call.sessionID,
            bridge_id: call.bridgeID,
            call_id: call.callID,
            message_seq: call.messageSeq,
          }
          const facts = { actions: ["read"], resources: ["public"] }
          const input = { request_id: "first", facts, save: ["public"] }
          const admit = (input: unknown) =>
            client.request("product_permission_admit", { source, input }) as Promise<Record>
          const reply = (record: Record, reply: string, message?: string) =>
            client.request("product_permission_reply", {
              source,
              response: {
                request_id: record.id,
                input_hash: record.input_hash,
                authority_revision: record.authority_revision,
                reply,
                ...(message === undefined ? {} : { message }),
              },
            })
          const pending = await admit(input)
          expect(pending.state).toBe("pending")
          expect(await admit(input)).toEqual(pending)
          expect(await failure(admit({ ...input, facts: { ...facts, resources: ["different"] } }))).toBeInstanceOf(
            Error,
          )
          expect(await client.request("product_permission_pending", { session_id: call.sessionID })).toEqual([pending])
          expect(await client.request("product_permission_status", { source, request_id: pending.id })).toEqual(pending)
          const withdrawal = await admit({ request_id: "withdraw", facts: { ...facts, resources: ["withdraw"] } })
          const other = await admit({ request_id: "withdraw-peer", facts: { ...facts, resources: ["other"] } })
          const withdraw = (request_id: string) => client.request("product_permission_cancel", { source, request_id })
          const cancelled = await withdraw(withdrawal.id)
          expect(cancelled).toMatchObject({ state: "cancelled", reason: "caller_cancelled", reply: null })
          expect(await withdraw(withdrawal.id)).toEqual(cancelled)
          expect(await client.request("product_permission_status", { source, request_id: other.id })).toMatchObject({
            state: "pending",
          })
          expect(await client.request("product_permission_status", { source, request_id: pending.id })).toMatchObject({
            state: "pending",
          })
          expect(await failure(reply(withdrawal, "always"))).toBeInstanceOf(Error)
          expect(await client.request("permission_pattern_list")).toEqual([])
          await withdraw(other.id)
          const sibling = await admit({ request_id: "peer", facts })
          expect(await reply(pending, "always")).toMatchObject({ state: "allowed", reply: "always" })
          expect(await client.request("product_permission_status", { source, request_id: sibling.id })).toMatchObject({
            state: "allowed",
            reply: "always",
          })
          expect(await reply(pending, "always")).toMatchObject({ state: "allowed" })
          expect(await client.request("permission_pattern_list")).toMatchObject([
            { source: "native", rule: { action: "read", resource: "public", effect: "allow" } },
          ])
          expect((await admit({ request_id: "remembered", facts })).state).toBe("allowed")
          const blocked = await admit({ request_id: "denied", facts: { ...facts, resources: ["secret"] } })
          expect(blocked.state).toBe("denied")
          expect(blocked).toMatchObject({
            reason: "policy_denied",
            denial: {
              effect: "deny",
              authority_revision: blocked.authority_revision,
            },
          })
          expect(ProductPermissionRequest.parse(blocked, call.sessionID)?.denial?.rules).toContainEqual({
            action: "read",
            resource: "secret",
            effect: "deny",
          })
          const corrected = await admit({ request_id: "corrected", facts: { ...facts, resources: ["correctable"] } })
          const declined = await admit({
            request_id: "declined-peer",
            facts: { ...facts, resources: ["peer-resource"] },
          })
          const feedback = "先检查配置，再修改。\nKeep the existing data."
          const denied = await reply(corrected, "reject", feedback)
          expect(denied).toMatchObject({ state: "denied", reason: "user_corrected", feedback })
          expect(await reply(corrected, "reject", feedback)).toEqual(denied)
          expect(await failure(reply(corrected, "reject", "different correction"))).toBeInstanceOf(Error)
          expect(await client.request("product_permission_status", { source, request_id: declined.id })).toMatchObject({
            state: "denied",
            reason: "user_rejected",
          })
          const next = await admit({ request_id: "cancel", facts: { ...facts, resources: ["different"] }, save: ["*"] })
          expect(next.state).toBe("pending")
          parked.resolve({ source, pending: next })
          await release.promise
          return {}
        } catch (error) {
          parked.reject(error)
          throw error
        }
      },
    })
    const onFinished = (event: EngineEvent) => {
      if (event.session_id === "s" && event.kind === "run.finished") finished.resolve()
    }
    client.onEvent(onFinished)
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
              { action: "read", resource: "secret", effect: "deny" },
            ],
          },
        },
      })
      await client.subscribe("s", 0)
      await client.request("resume", { session_id: "s" })
      const result = await Promise.race([
        parked.promise,
        Bun.sleep(10_000).then(() => {
          throw new Error("host assertion fixture timed out")
        }),
      ])
      await client.request("cancel", { session_id: "s" })
      expect(
        await failure(
          client.request("product_permission_reply", {
            source: result.source,
            response: {
              request_id: result.pending.id,
              input_hash: result.pending.input_hash,
              authority_revision: result.pending.authority_revision,
              reply: "always",
            },
          }),
        ),
      ).toBeInstanceOf(Error)
      // Cancel acknowledges the interruption; run.finished publishes its durable cleanup.
      await Promise.race([
        finished.promise,
        Bun.sleep(10_000).then(() => {
          throw new Error("cancelled run did not finish")
        }),
      ])
      expect(await client.request("product_permission_pending", { session_id: "s" })).toEqual([])
      expect(await client.request("permission_pattern_list")).toMatchObject([{ rule: { resource: "public" } }])
      const events = (await client.request("events", { session_id: "s", after: 0 })) as {
        kind: string
        data: { state?: string }
      }[]
      expect(
        events.filter((event) => event.kind === "product.permission.resolved").map((event) => event.data.state),
      ).toEqual(["cancelled", "cancelled", "allowed", "allowed", "denied", "denied", "cancelled"])
    } finally {
      client.offEvent(onFinished)
      release.resolve()
      await client.close()
      await provider.stop(true)
    }
  },
  20_000,
)
