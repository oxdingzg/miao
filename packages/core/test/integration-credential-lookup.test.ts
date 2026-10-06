import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Tracer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Credential } from "@miao/core/credential"
import { EventV2 } from "@miao/core/event"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { Integration } from "@miao/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, FSUtil.node])),
)
const id = Integration.ID.make("credential-lookup")

// Observe the real Effect services without replacing their DB/filesystem work.
const trace = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const native = yield* Effect.tracer
  const names: string[] = []
  const value = yield* effect.pipe(
    Effect.provideService(
      Tracer.Tracer,
      Tracer.make({
        span(options) {
          names.push(options.name)
          return native.span(options)
        },
      }),
    ),
  )
  return { value, names }
})

describe("Integration credential reads", () => {
  it.live("reads an existing credential once per get or active call and observes later changes", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      yield* integrations.transform((editor) => editor.update(id, () => {}))
      const first = yield* credentials.create({
        integrationID: id,
        label: "First",
        value: Credential.Key.make({ type: "key", key: "first" }),
      })
      const lookup = yield* trace(
        Effect.gen(function* () {
          const info = yield* integrations.get(id)
          const active = yield* integrations.connection.active(id)
          return { info, active }
        }),
      )
      expect(lookup.names.filter((name) => name === "Credential.list")).toHaveLength(2)
      expect(lookup.value.info?.connections).toEqual([{ type: "credential", id: first.id, label: "First" }])
      expect(lookup.value.active).toEqual({ type: "credential", id: first.id, label: "First" })
      yield* credentials.update(first.id, {
        label: "Updated",
        value: Credential.Key.make({ type: "key", key: "updated" }),
      })
      const updated = yield* integrations.connection.active(id)
      if (!updated) throw new Error("Expected updated connection")
      expect(updated).toMatchObject({ type: "credential", label: "Updated" })
      expect(yield* integrations.connection.resolve(updated)).toEqual(
        Credential.Key.make({ type: "key", key: "updated" }),
      )
      yield* credentials.remove(first.id)
      expect((yield* integrations.get(id))?.connections).toEqual([])
      expect(yield* integrations.connection.active(id)).toBeUndefined()
      expect(yield* integrations.connection.resolve(updated)).toBeUndefined()
      const replacement = yield* credentials.create({
        integrationID: id,
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* integrations.connection.active(id)).toMatchObject({ type: "credential", id: replacement.id })
    }),
  )

  it.live("still re-reads after adopting a legacy OAuth credential", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const fs = yield* FSUtil.Service
      const auth = path.join(Global.Path.data, "auth.json")
      const previous = yield* fs.readFileStringSafe(auth)
      yield* Effect.addFinalizer(() =>
        previous === undefined
          ? fs.remove(auth, { force: true }).pipe(Effect.ignore)
          : fs.writeFileString(auth, previous).pipe(Effect.ignore),
      )
      const methodID = Integration.MethodID.make("legacy-oauth")
      yield* integrations.transform((editor) =>
        editor.method.update({
          integrationID: id,
          method: { type: "oauth", id: methodID, label: "Legacy" },
          authorize: () => Effect.die("Interactive authorization is not used by legacy adoption"),
        }),
      )
      yield* fs.writeJson(auth, {
        [id]: { type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: Date.now() + 3_600_000 },
      })
      const lookup = yield* trace(integrations.connection.active(id))
      expect(lookup.names.filter((name) => name === "Credential.list")).toHaveLength(2)
      if (!lookup.value) throw new Error("Expected imported connection")
      expect(yield* integrations.connection.resolve(lookup.value)).toMatchObject({
        access: "legacy-access",
        refresh: "legacy-refresh",
        methodID,
      })
      expect(yield* credentials.list(id)).toHaveLength(1)
    }),
  )

  if (process.env.MIAO_BENCHMARK_CREDENTIALS === "1")
    it.live("benchmarks real get, active, and resolve calls", () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        yield* integrations.transform((editor) => editor.update(id, () => {}))
        yield* credentials.create({ integrationID: id, value: Credential.Key.make({ type: "key", key: "test-key" }) })
        const lookup = Effect.gen(function* () {
          yield* integrations.get(id)
          const connection = yield* integrations.connection.active(id)
          if (!connection) throw new Error("Expected connection")
          return yield* integrations.connection.resolve(connection)
        })
        const observed = yield* trace(lookup)
        yield* Effect.forEach(Array.from({ length: 10 }), () => lookup, { discard: true })
        const samples = yield* Effect.forEach(Array.from({ length: 100 }), () =>
          Effect.gen(function* () {
            const start = performance.now()
            yield* lookup
            return performance.now() - start
          }),
        )
        const sorted = samples.toSorted((a, b) => a - b)
        console.log(
          JSON.stringify({
            n: samples.length,
            credentialListCalls: observed.names.filter((name) => name === "Credential.list").length,
            credentialGetCalls: observed.names.filter((name) => name === "Credential.get").length,
            p50: sorted[49],
            p90: sorted[89],
            p99: sorted[98],
          }),
        )
      }),
    )
})
