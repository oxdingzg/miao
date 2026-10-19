import { expect, test } from "bun:test"
import { Effect } from "effect"
import { engine } from "../../src/engine/transfer"

test("transfer engine maps coordinator operations onto Host transfer commands", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request(method: string, params?: unknown) {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === "transfer_validate") return { bundle_sha256: "digest", message_count: 1 }
      return {
        id: "transfer",
        session_id: "session",
        bundle_sha256: "digest",
        state: method === "transfer_stage" ? "staged" : "active",
      }
    },
  }
  const host = engine(client)
  const path = "/tmp/bundle.json"
  const identity = { protocol: "openai-chat", model: "fixture" }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* host.validate({
        path: path as never,
        bundleSHA256: "digest",
        identity,
        routeID: "route",
        agent: { name: "build" },
      })
      const staged = yield* host.stage({
        importID: "transfer",
        path: path as never,
        bundleSHA256: "digest",
        identity,
        routeID: "route",
        agent: { name: "build" },
      })
      expect(staged.state).toBe("staged")
      const active = yield* host.activate({
        importID: "transfer",
        bundleSHA256: "digest",
        productDatabase: "/tmp/product.db" as never,
      })
      expect(active.state).toBe("active")
    }),
  )
  expect(calls.map((call) => call.method)).toEqual(["transfer_validate", "transfer_stage", "transfer_activate"])
  expect(calls[0]?.params).toEqual({
    path,
    bundle_sha256: "digest",
    identity,
    route_id: "route",
    agent: { name: "build" },
  })
  expect(calls[1]?.params).toMatchObject({ import_id: "transfer", bundle_sha256: "digest", route_id: "route" })
  expect(calls[2]?.params).toEqual({
    import_id: "transfer",
    bundle_sha256: "digest",
    product_database: "/tmp/product.db",
  })
})

test("transfer engine surfaces malformed receipts and transport failures", async () => {
  const host = engine({
    async request() {
      return { id: "transfer" }
    },
  })
  const failed = await Effect.runPromise(
    host
      .stage({
        importID: "transfer",
        path: "/tmp/bundle.json" as never,
        bundleSHA256: "digest",
        identity: { protocol: "p", model: "m" },
      })
      .pipe(Effect.exit),
  )
  expect(failed._tag).toBe("Failure")
  const offline = engine({
    async request() {
      throw new Error("engine exited")
    },
  })
  const transport = await Effect.runPromise(
    offline
      .validate({ path: "/tmp/bundle.json" as never, bundleSHA256: "digest", identity: { protocol: "p", model: "m" } })
      .pipe(Effect.exit),
  )
  expect(transport._tag).toBe("Failure")
})
