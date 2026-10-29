import { expect, test } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { AbsolutePath } from "@miao/schema/schema"
import { Location } from "@miao/schema/location"
import { SessionID } from "@miao/schema/session-id"
import { Permission } from "@miao/schema/permission"
import { Deferred, Effect, Schema } from "effect"
import { fromOwners } from "@/engine/native-engine"
import { makeEngineOwners } from "@/engine/owners"
import { ProductPermissionRequest } from "@/engine/product-permission-request"
import { EngineTranslator, type EngineSessionEvent } from "@/engine/session"
import { replayJournal } from "@/engine/journal"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const binding = {
  id: "host-request",
  workspace: "/workspace",
  input_hash: "a".repeat(64),
  authority_revision: "b".repeat(64),
  source: { session_id: "ses_host", bridge_id: 4, call_id: "call", message_seq: 8 },
  request: {
    request_id: "host-request",
    facts: { actions: ["read", "read_file"], resources: ["file"] },
    save: ["*"],
    metadata: { title: "Read file", nativeHostPermission: "untrusted" },
  },
  state: "pending",
  reply: null,
  reason: null,
}

const event = {
  session_id: "ses_host",
  seq: 10,
  kind: "product.permission.requested",
  recorded_at_ms: 1000,
  data: binding,
}

test("native host permission projection has stable namespaced identity and actual tool source", () => {
  const first = ProductPermissionRequest.asked(event)
  if (!first) throw new Error("host permission was not projected")
  expect(first).toMatchObject({
    id: `per_host_${binding.input_hash}`,
    sessionID: "ses_host",
    action: "read",
    resources: ["file"],
    save: ["*"],
    source: { type: "tool", messageID: "msg_ses_host_8", callID: "call" },
    metadata: { title: "Read file", nativeHostPermission: { requestID: "host-request" } },
  })
  expect(Schema.decodeUnknownSync(Permission.Request)(first)).toEqual(first)
  const outputs: EngineSessionEvent[] = []
  const translator = new EngineTranslator((item) => outputs.push(item))
  translator.dispatch(event)
  translator.dispatch({
    ...event,
    seq: 11,
    kind: "product.permission.resolved",
    data: { ...binding, state: "allowed", reply: "always" },
  })
  expect(outputs.map((item) => item.type)).toEqual(["permission.v2.asked", "permission.v2.replied"])
  expect(outputs[1].data).toEqual({ sessionID: "ses_host", requestID: first!.id, reply: "always" })
  const replayed: EngineSessionEvent[] = []
  new EngineTranslator((item) => replayed.push(item)).dispatch(event)
  expect(replayed[0]).toEqual(outputs[0])
})

test("native host permission projection refuses foreign or malformed bindings and maps terminal declines", () => {
  for (const data of [
    { ...binding, id: "different" },
    { ...binding, input_hash: "bad" },
    { ...binding, source: { ...binding.source, session_id: "ses_foreign" } },
    { ...binding, source: { ...binding.source, bridge_id: -1 } },
    { ...binding, request: { ...binding.request, facts: { actions: [], resources: ["file"] } } },
  ])
    expect(ProductPermissionRequest.asked({ ...event, data })).toBeUndefined()
  for (const state of ["denied", "cancelled", "expired"]) {
    expect(
      ProductPermissionRequest.replied({
        ...event,
        kind: "product.permission.resolved",
        data: { ...binding, state, reply: "once" },
      }),
    ).toMatchObject({ reply: "reject" })
  }
  expect(
    ProductPermissionRequest.replied({
      ...event,
      kind: "product.permission.resolved",
      data: { ...binding, state: "allowed", reply: null },
    }),
  ).toBeUndefined()
})

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN
if (!binary) test.skip("native host permissions are listed, replied and replayed through the product facade", () => {})
if (binary)
  it.live(
    "native host permissions are listed, replied and replayed through the product facade",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const policyFile = path.join(tmp.path, "policy.json")
        const productToolsFile = path.join(tmp.path, "tools.json")
        yield* Effect.promise(() =>
          Bun.write(policyFile, JSON.stringify({ rules: [{ tool: "*", path: "**", decision: "allow" }] })),
        )
        yield* Effect.promise(() =>
          Bun.write(
            productToolsFile,
            JSON.stringify({
              tools: [
                {
                  name: "host_probe",
                  description: "Permission view fixture",
                  input_schema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            }),
          ),
        )
        const provider = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () =>
            new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "host-call", type: "function", function: { name: "host_probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => provider.stop(true)))
        const input = {
          sessionID: SessionID.make("ses_native_host_view"),
          storage: AbsolutePath.make(path.join(tmp.path, "engine.db")),
          location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
        }
        const parked = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const asked = yield* Deferred.make<Permission.Request>()
        const clients = yield* ClientEvents.Service
        const unsubscribe = yield* clients.listen((item) =>
          item.type === "permission.v2.asked"
            ? Deferred.succeed(asked, Schema.decodeUnknownSync(Permission.Request)(item.data)).pipe(Effect.asVoid)
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const owners: Effect.Success<ReturnType<typeof makeEngineOwners>> = yield* makeEngineOwners({
          binary,
          model: "fixture",
          provider: "openai-chat",
          endpoint: new URL("chat/completions", provider.url).toString(),
          policyFile,
          productToolsFile,
          env: { OPENAI_API_KEY: "fixture-only" },
          async onProductTool(call) {
            try {
              if (call.messageSeq === undefined) throw new Error("missing source identity")
              const connection = await Effect.runPromise(owners.get({ ...input, engineID: input.storage }))
              const source = {
                session_id: call.sessionID,
                bridge_id: call.bridgeID,
                call_id: call.callID,
                message_seq: call.messageSeq,
              }
              for (const [id, resource] of [
                ["first", "public"],
                ["second", "other"],
              ])
                await connection.client.request("product_permission_admit", {
                  source,
                  input: {
                    request_id: id,
                    facts: { actions: ["read"], resources: [resource] },
                    save: [resource],
                    metadata: { title: resource },
                  },
                })
              parked.resolve()
              await release.promise
              return {}
            } catch (error) {
              parked.reject(error)
              throw error
            }
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
        const native = fromOwners(owners, { hostPermissions: true })
        yield* native.admit({ ...input, prompt: { text: "call host" }, resume: false })
        const connection = yield* owners.get({ ...input, engineID: input.storage })
        yield* Effect.promise(() =>
          connection.client.request("select_agent", {
            session_id: input.sessionID,
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
          }),
        )
        yield* Effect.promise(() => connection.client.request("resume", { session_id: input.sessionID }))
        yield* Effect.promise(() => parked.promise).pipe(Effect.timeout("10 seconds"))
        const live = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
        const pending = yield* native.permissions(input)
        expect(pending).toHaveLength(2)
        const first = pending.find((item) => item.resources[0] === "public")!
        const second = pending.find((item) => item.resources[0] === "other")!
        expect(first.id).toBe(live.id)
        expect(first.id).toStartWith("per_host_")
        yield* native.admit({
          ...input,
          sessionID: SessionID.make("ses_foreign_host_view"),
          prompt: { text: "other" },
          resume: false,
        })
        const cross = yield* native
          .replyPermission({
            ...input,
            sessionID: SessionID.make("ses_foreign_host_view"),
            requestID: first.id,
            reply: "always",
          })
          .pipe(Effect.flip)
        expect(cross._tag).toBe("ConflictError")
        yield* native.replyPermission({ ...input, requestID: first.id, reply: "always" })
        expect(yield* native.permissions(input)).toEqual([second])
        yield* native.replyPermission({ ...input, requestID: second.id, reply: "reject", message: "Use a safer path" })
        expect(yield* native.permissions(input)).toEqual([])
        const journal = yield* Effect.promise(() =>
          replayJournal({
            sessionID: input.sessionID,
            engineID: input.storage,
            location: input.location,
            after: 0,
            request: (method, params) => connection.client.request(method, params),
          }),
        )
        const permissions = journal.events.filter(
          (item) => item.type === "permission.v2.asked" || item.type === "permission.v2.replied",
        )
        expect(permissions.map((item) => item.type)).toEqual([
          "permission.v2.asked",
          "permission.v2.asked",
          "permission.v2.replied",
          "permission.v2.replied",
        ])
        expect(permissions[0].data).toEqual(first)

        const raw = yield* Effect.promise(() =>
          connection.client.request("events", { session_id: input.sessionID, after: 0 }),
        )
        expect(
          (raw as { kind: string; data: { feedback?: string } }[])
            .filter((item) => item.kind === "product.permission.resolved")
            .map((item) => item.data.feedback),
        ).toEqual([undefined, "Use a safer path"])
        yield* Effect.promise(() => connection.client.cancel(input.sessionID))
      }),
    30_000,
  )
