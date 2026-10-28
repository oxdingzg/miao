import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { PermissionV2 } from "@miao/core/permission"
import { Permission } from "@miao/schema/permission"
import { SessionID } from "@miao/schema/session-id"
import { EngineClient } from "@/engine/client"
import { capabilities } from "@/engine/discovery"
import { messageID } from "@/engine/identity"
import { NativeHostPermission } from "@/engine/native-host-permission"
import { ProductPermissionRequest } from "@/engine/product-permission-request"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "source-bound adapter consumes native decisions and once/always replies",
  async () => {
    await using fixture = await open()
    const allowed = await Effect.runPromise(
      fixture.permission.ask(fixture.request("allowed", "public", { action: "noop" })),
    )
    expect(allowed.effect).toBe("allow")
    expect(fixture.asked).toHaveLength(0)
    const denied = await Effect.runPromise(
      Effect.result(fixture.permission.assert(fixture.request("denied", "secret"))),
    )
    expect(Result.isFailure(denied)).toBe(true)
    if (Result.isFailure(denied)) {
      expect(denied.failure).toBeInstanceOf(PermissionV2.BlockedError)
      if (denied.failure instanceof PermissionV2.BlockedError)
        expect(denied.failure.rules).toContainEqual({ action: "read", resource: "secret", effect: "deny" })
    }
    const aliases = await Effect.runPromise(
      Effect.result(
        fixture.permission.assert(fixture.request("alias", "secret", { action: "new_read", aliases: ["read"] })),
      ),
    )
    expect(Result.isFailure(aliases)).toBe(true)
    const explicit = await Effect.runPromise(
      fixture.permission.ask(fixture.request("explicit", "public", { action: "external_directory", explicit: true })),
    )
    expect(explicit.effect).toBe("ask")
    await fixture.client.request("product_permission_cancel", { source: fixture.source, request_id: "per_explicit" })
    const first = Effect.runPromise(fixture.permission.assert(fixture.request("once", "public")))
    const once = await fixture.wait("once")
    await fixture.reply(once, "once")
    await first
    const second = Effect.runPromise(
      fixture.permission.assert(fixture.request("always", "public", { save: ["public"] })),
    )
    const always = await fixture.wait("always")
    await fixture.reply(always, "always")
    await second
    await Effect.runPromise(fixture.permission.assert(fixture.request("remembered", "public")))
    expect(fixture.asked.map((item) => item.id)).toEqual(["per_explicit", "per_once", "per_always"])
    expect(await fixture.client.request("permission_pattern_list")).toMatchObject([
      { rule: { action: "read", resource: "public", effect: "allow" } },
    ])
    expect(
      await fixture.client.request("product_permission_pending", { session_id: fixture.source.session_id }),
    ).toEqual([])
  },
  20_000,
)

test.skipIf(!binary)(
  "source-bound adapter preserves corrected declines and withdraws interrupted waits only",
  async () => {
    await using fixture = await open()
    const corrected = Effect.runPromise(
      Effect.result(fixture.permission.assert(fixture.request("corrected", "correctable"))),
    )
    await fixture.reply(await fixture.wait("corrected"), "reject", "Inspect the settings first")
    const result = await corrected
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: "PermissionV2.CorrectedError",
        feedback: "Inspect the settings first",
      })
    const declined = Effect.runPromiseExit(fixture.permission.assert(fixture.request("declined", "other")))
    await fixture.reply(await fixture.wait("declined"), "reject")
    const exit = await declined
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV2.DeclinedError)
    const peer = await Effect.runPromise(fixture.permission.ask(fixture.request("peer", "peer")))
    expect(peer.effect).toBe("ask")
    const fiber = Effect.runFork(
      fixture.permission.assert(fixture.request("interrupt", "different", { metadata: { stdin: null } })),
    )
    await fixture.wait("interrupt")
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(
      await fixture.client.request("product_permission_status", {
        source: fixture.source,
        request_id: "per_interrupt",
      }),
    ).toMatchObject({ state: "cancelled", reason: "caller_cancelled", request: { metadata: { stdin: null } } })
    expect(
      await fixture.client.request("product_permission_pending", { session_id: fixture.source.session_id }),
    ).toMatchObject([{ id: "per_peer", state: "pending" }])
    expect(await fixture.client.request("permission_pattern_list")).toEqual([])
    await fixture.client.request("product_permission_cancel", { source: fixture.source, request_id: "per_peer" })
  },
  20_000,
)

test.skipIf(!binary)(
  "adapter refuses missing capabilities and foreign invocation sources before admission",
  async () => {
    await using fixture = await open()
    const unsupported = NativeHostPermission.make({
      client: fixture.client,
      source: fixture.source,
      capabilities: { ...fixture.supported, productPermissionCancel: undefined },
    })
    for (const [permission, request, code] of [
      [unsupported, fixture.request("old", "public"), "host_permission_unsupported"],
      [
        fixture.permission,
        fixture.request("foreign", "public", { sessionID: SessionID.make("ses_foreign") }),
        "host_permission_source_mismatch",
      ],
      [
        fixture.permission,
        fixture.request("missing", "public", { source: undefined }),
        "host_permission_source_mismatch",
      ],
      [
        fixture.permission,
        fixture.request("call", "public", {
          source: {
            type: "tool",
            messageID: messageID(fixture.source.session_id, fixture.source.message_seq),
            callID: "foreign",
          },
        }),
        "host_permission_source_mismatch",
      ],
    ] as const) {
      const exit = await Effect.runPromiseExit(permission.assert(request))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code })
    }
    expect(fixture.asked).toHaveLength(0)
    expect(
      await fixture.client.request("product_permission_pending", { session_id: fixture.source.session_id }),
    ).toEqual([])
  },
  20_000,
)

async function open() {
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
