import { expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { ClientEvents } from "@miao/server/client-events"
import { Location } from "@miao/schema/location"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { EngineClient, EngineError } from "@/engine/client"
import { makeEngineOwners } from "@/engine/owners"
import { testEffectShared } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffectShared(AppNodeBuilder.build(ClientEvents.node))
const binary = process.env.MIAO_ENGINE_BIN

if (!binary) test.skip("native owners survive request scopes and release their database leases", () => {})
if (binary)
  it.live(
    "native owners survive request scopes and release their database leases",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const location = Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path })
        const input = { storage: path.join(tmp.path, "engine.db"), engineID: "native-owner", location }
        const configuration = {
          binary,
          model: "fixture",
          provider: "openai-chat",
          env: { OPENAI_API_KEY: "fixture-only" },
        }
        const owners = yield* Effect.scoped(
          Effect.gen(function* () {
            const owners = yield* makeEngineOwners(configuration)
            const connections = yield* Effect.all(
              [Effect.scoped(owners.get(input)), Effect.scoped(owners.get(input))],
              { concurrency: "unbounded" },
            )
            expect(connections[0]).toBe(connections[1])
            // Both request scopes have closed, but the server owns the child.
            expect(
              yield* Effect.promise(() => connections[0].client.request("events", { session_id: "s", after: 0 })),
            ).toEqual([])
            const conflict = yield* owners.get({ ...input, engineID: "different-owner" }).pipe(Effect.flip)
            expect(conflict.code).toBe("engine_owner_conflict")
            const placementConflict = yield* owners
              .get({
                ...input,
                location: Schema.decodeUnknownSync(Location.Ref)({ directory: path.dirname(tmp.path) }),
              })
              .pipe(Effect.flip)
            expect(placementConflict.code).toBe("engine_owner_conflict")
            const other = yield* owners.get({ ...input, storage: path.join(tmp.path, "other.db"), engineID: "other" })
            expect(other).not.toBe(connections[0])
            expect(yield* Effect.promise(() => other.client.request("events", { session_id: "s", after: 0 }))).toEqual(
              [],
            )
            expect(yield* owners.sweepTimers().pipe(Effect.timeout("2 seconds"))).toEqual([
              { storage: input.storage, sessions: [] },
              { storage: path.join(tmp.path, "other.db"), sessions: [] },
            ])
            yield* Effect.promise(() => connections[0].client.close())
            expect(connections[0].client.available).toBe(false)
            // A dead engine with no timers is released instead of resurrected;
            // the next request to the storage re-owns it on demand.
            const sweeps = yield* Effect.all([owners.sweepTimers(), owners.sweepTimers()], {
              concurrency: "unbounded",
            }).pipe(Effect.timeout("3 seconds"))
            expect(sweeps.every((result) => result.length === 1)).toBe(true)
            const recovered = yield* owners.get(input)
            expect(recovered).not.toBe(connections[0])
            expect(recovered.client.available).toBe(true)
            expect(yield* owners.get(input)).toBe(recovered)
            // The released storage re-armed on demand; the supervisor sees it again.
            expect((yield* owners.sweepTimers().pipe(Effect.timeout("2 seconds"))).length).toBe(2)
            expect(yield* owners.get({ ...input, storage: path.join(tmp.path, "other.db"), engineID: "other" })).toBe(
              other,
            )
            expect(
              yield* Effect.promise(() => recovered.client.request("events", { session_id: "s", after: 0 })),
            ).toEqual([])
            // A real request can replace a dead connection while a timer
            // sweep still holds the old owner's snapshot.
            for (let attempt = 0; attempt < 10; attempt++) {
              const current = yield* owners.get(input)
              yield* Effect.promise(() => current.client.close())
              const raced = yield* Effect.all([owners.sweepTimers(), owners.get(input)], {
                concurrency: "unbounded",
              })
              expect(yield* owners.get(input)).toBe(raced[1])
            }
            return owners
          }),
        )
        expect((yield* owners.get(input).pipe(Effect.flip)).code).toBe("engine_owner_closed")
        // A new native process can acquire the same storage after server shutdown.
        const replacement = EngineClient.start({ ...configuration, db: input.storage, workspace: tmp.path })
        yield* Effect.addFinalizer(() => Effect.promise(() => replacement.close()))
        expect(yield* Effect.promise(() => replacement.request("events", { session_id: "s", after: 0 }))).toEqual([])
      }),
    15_000,
  )

if (binary) {
  for (const operation of ["replace", "sweep"] as const) {
    it.live(
      `native owner ${operation} releases its prepared resources without closing another owner`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const files: string[] = []
          const released: string[] = []
          const input = {
            storage: path.join(tmp.path, "first.db"),
            engineID: "first",
            location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const owners = yield* makeEngineOwners(
                { binary, model: "fixture", provider: "openai-chat", env: { OPENAI_API_KEY: "fixture-only" } },
                () =>
                  Effect.gen(function* () {
                    const file = path.join(tmp.path, `prepared-${files.length}`)
                    yield* Effect.acquireRelease(
                      Effect.promise(() => Bun.write(file, "owner resource")),
                      () =>
                        Effect.promise(async () => {
                          await rm(file)
                          released.push(file)
                        }),
                    )
                    files.push(file)
                    return { options: {}, refresh: Effect.void }
                  }),
              )
              const first = yield* Effect.scoped(owners.get(input))
              const other = yield* owners.get({ ...input, storage: path.join(tmp.path, "other.db"), engineID: "other" })
              expect(yield* Effect.promise(() => Bun.file(files[0]).exists())).toBe(true)
              expect(yield* owners.get(input)).toBe(first)
              expect(files).toHaveLength(2)
              yield* Effect.promise(() => first.client.close())
              if (operation === "sweep") {
                yield* owners.sweepTimers()
                expect(yield* Effect.promise(() => Bun.file(files[0]).exists())).toBe(false)
                expect(files).toHaveLength(2)
              }
              const replacement = yield* owners.get(input)
              expect(replacement).not.toBe(first)
              expect(replacement.client.available).toBe(true)
              expect(released).toEqual([files[0]])
              expect(yield* Effect.promise(() => Bun.file(files[0]).exists())).toBe(false)
              expect(yield* Effect.promise(() => Bun.file(files[1]).exists())).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(files[2]).exists())).toBe(true)
              expect(yield* owners.get({ ...input, storage: path.join(tmp.path, "other.db"), engineID: "other" })).toBe(
                other,
              )
            }),
          )
          expect(released.toSorted()).toEqual(files.toSorted())
          expect(yield* Effect.promise(() => Promise.all(files.map((file) => Bun.file(file).exists())))).toEqual([
            false,
            false,
            false,
          ])
        }),
      15_000,
    )
  }

  for (const failure of ["prepare", "connect", "interrupt"] as const) {
    it.live(
      `failed native owner ${failure} releases prepared resources before the server closes`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const file = path.join(tmp.path, "prepared-resource")
          const ready = yield* Deferred.make<void>()
          const owners = yield* makeEngineOwners({ binary, model: "fixture", provider: "openai-chat" }, () =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.promise(() => Bun.write(file, "owner resource")),
                () => Effect.promise(() => rm(file)),
              )
              if (failure === "prepare") return yield* Effect.fail(new EngineError("fixture_prepare", "prepare failed"))
              if (failure === "interrupt") {
                yield* Deferred.succeed(ready, undefined)
                yield* Effect.never
              }
              return { options: { binary: path.join(tmp.path, "missing-engine") }, refresh: Effect.void }
            }),
          )
          const input = {
            storage: path.join(tmp.path, "engine.db"),
            engineID: "failed-owner",
            location: Schema.decodeUnknownSync(Location.Ref)({ directory: tmp.path }),
          }
          if (failure === "interrupt") {
            const fiber = yield* owners.get(input).pipe(Effect.forkChild)
            yield* Deferred.await(ready)
            expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
            yield* Fiber.interrupt(fiber)
          }
          if (failure !== "interrupt") expect(Exit.isFailure(yield* owners.get(input).pipe(Effect.exit))).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
        }),
      10_000,
    )
  }
}
