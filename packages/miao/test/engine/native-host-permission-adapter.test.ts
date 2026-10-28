import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { PermissionV2 } from "@miao/core/permission"
import { SessionID } from "@miao/schema/session-id"
import { messageID } from "@/engine/identity"
import { NativeHostPermission } from "@/engine/native-host-permission"
import { nativeHostSource } from "../fixture/native-host-source"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "source-bound adapter consumes native decisions and once/always replies",
  async () => {
    await using fixture = await nativeHostSource()
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
    await using fixture = await nativeHostSource()
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
    await using fixture = await nativeHostSource()
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
