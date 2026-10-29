import path from "node:path"
import { PermissionV2 } from "@miao/core/permission"
import { Permission } from "@miao/schema/permission"
import { SessionID } from "@miao/schema/session-id"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { messageID } from "@/engine/identity"
import { NativeHostPermission } from "@/engine/native-host-permission"
import { ProductPermissionRequest } from "@/engine/product-permission-request"
import { tmpdir } from "./fixture"

const binary = process.env.MIAO_ENGINE_BIN

export async function nativeHostSource() {
  if (!binary) throw new Error("native engine required")
  const supported = capabilities(binary)
  if (!supported) throw new Error("native capabilities required")
  const tmp = await tmpdir()
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
          description: "Permission adapter fixture",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    }),
  )
  const ready = Promise.withResolvers<ProductPermissionRequest.Source>()
  const release = Promise.withResolvers<void>()
  const asked: ProductPermissionRequest.Info[] = []
  const waiters = new Map<string, (info: ProductPermissionRequest.Info) => void>()
  const client = EngineClient.start({
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
      if (call.messageSeq === undefined) throw new Error("source message identity required")
      ready.resolve(
        new ProductPermissionRequest.Source({
          session_id: call.sessionID,
          bridge_id: call.bridgeID,
          call_id: call.callID,
          message_seq: call.messageSeq,
        }),
      )
      await release.promise
      return {}
    },
  })
  client.onEvent((event) => {
    if (event.kind !== "product.permission.requested") return
    const info = ProductPermissionRequest.parse(event.data, event.session_id)
    if (!info) return
    asked.push(info)
    waiters.get(info.id)?.(info)
    waiters.delete(info.id)
  })
  const sessionID = SessionID.make("ses_host_adapter")
  try {
    await client.admit({ session_id: sessionID, input_id: "one", prompt: "call host", delivery: "steer" }, false)
    await client.request("select_agent", {
      session_id: sessionID,
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
    await client.subscribe(sessionID, 0)
    await client.request("resume", { session_id: sessionID })
    const source = await Promise.race([
      ready.promise,
      Bun.sleep(10_000).then(() => {
        throw new Error("native source fixture timed out")
      }),
    ])
    return {
      directory: tmp.path,
      storage: path.join(tmp.path, "engine.db"),
      client,
      source,
      supported,
      asked,
      permission: NativeHostPermission.make({ client, source, capabilities: supported }),
      request(id: string, resource: string, more: Partial<PermissionV2.AssertInput> = {}): PermissionV2.AssertInput {
        return {
          id: Permission.ID.make(`per_${id}`),
          sessionID,
          action: "read",
          resources: [resource],
          source: { type: "tool", messageID: messageID(source.session_id, source.message_seq), callID: source.call_id },
          ...more,
        }
      },
      wait(id: string) {
        const key = `per_${id}`
        const existing = asked.find((info) => info.id === key)
        if (existing) return Promise.resolve(existing)
        const ready = Promise.withResolvers<ProductPermissionRequest.Info>()
        waiters.set(key, ready.resolve)
        return Promise.race([
          ready.promise,
          Bun.sleep(5_000).then(() => {
            throw new Error(`no native permission request: ${id}`)
          }),
        ])
      },
      reply(info: ProductPermissionRequest.Info, reply: Permission.Reply, message?: string) {
        return client.request("product_permission_reply", {
          source,
          response: {
            request_id: info.id,
            input_hash: info.input_hash,
            authority_revision: info.authority_revision,
            reply,
            ...(message === undefined ? {} : { message }),
          },
        })
      },
      async [Symbol.asyncDispose]() {
        release.resolve()
        await client.close()
        await provider.stop(true)
        await tmp[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    release.resolve()
    await client.close()
    await provider.stop(true)
    await tmp[Symbol.asyncDispose]()
    throw error
  }
}
