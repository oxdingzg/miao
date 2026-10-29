import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { AgentV2 } from "@miao/core/agent"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSource } from "@miao/core/permission/source"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { SessionTable } from "@miao/core/session/sql"
import { location } from "../../../core/test/fixture/location"
import { nativeHostSource } from "../fixture/native-host-source"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "captured Core permissions and independent plugin promises use the bound native authority",
  async () => {
    await using fixture = await nativeHostSource()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* setup(fixture)
          const permission = yield* PermissionV2.Service
          const sources = yield* PermissionSource.Service
          const request = fixture.request("source", "*")
          if (request.source?.type !== "tool") throw new Error("tool source required")
          yield* sources.bind({ sessionID: request.sessionID, source: request.source, executor: fixture.permission })
          // The TS agent is deny-all. A successful noop is therefore native, not fallback.
          yield* permission.assert(fixture.request("native-allow", "*", { action: "noop" }))
          yield* Effect.promise(() =>
            Effect.runPromise(permission.assert(fixture.request("plugin-promise", "*", { action: "noop" }))),
          )
          const denied = yield* Effect.exit(permission.assert(fixture.request("native-deny", "secret")))
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied))
            expect(Cause.squash(denied.cause)).toMatchObject({
              rules: [
                { action: "*", resource: "*", effect: "allow" },
                { action: "read", resource: "*", effect: "ask" },
                { action: "read", resource: "secret", effect: "deny" },
              ],
            })
          const fiber = yield* permission.assert(fixture.request("native-ask", "public")).pipe(Effect.forkScoped)
          const pending = yield* Effect.promise(() => fixture.wait("native-ask"))
          yield* Effect.promise(() => fixture.reply(pending, "once"))
          yield* Fiber.join(fiber)
          expect(yield* permission.list()).toEqual([])
          expect(fixture.asked.map((record) => record.id)).toEqual(["per_native-ask"])
        }).pipe(Effect.provide(services(fixture)), Effect.timeout("20 seconds")),
      ),
    )
  },
  25_000,
)

test.skipIf(!binary)(
  "native placement requires a binding from its first permission call and rejects duplicate or released sources",
  async () => {
    await using fixture = await nativeHostSource()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* setup(fixture)
          const permission = yield* PermissionV2.Service
          const sources = yield* PermissionSource.Service
          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("test"), (agent) => {
              agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
            }),
          )
          const request = fixture.request("bound", "*", { action: "noop" })
          if (request.source?.type !== "tool") throw new Error("tool source required")
          const missing = yield* Effect.exit(permission.assert(request))
          expect(Exit.isFailure(missing)).toBe(true)
          if (Exit.isFailure(missing))
            expect(Cause.squash(missing.cause)).toMatchObject({
              _tag: "PermissionSource.Unavailable",
              reason: "missing_binding",
            })
          const scope = yield* Scope.make()
          const binding = { sessionID: request.sessionID, source: request.source, executor: fixture.permission }
          yield* sources.bind(binding).pipe(Effect.provideService(Scope.Scope, scope))
          yield* permission.assert(request)
          const duplicate = yield* Effect.exit(sources.bind(binding))
          expect(Exit.isFailure(duplicate)).toBe(true)
          if (Exit.isFailure(duplicate))
            expect(Cause.squash(duplicate.cause)).toMatchObject({ reason: "duplicate_binding" })
          const foreign = yield* Effect.exit(
            permission.assert({ ...request, source: { ...request.source, callID: "other" } }),
          )
          expect(Exit.isFailure(foreign)).toBe(true)
          if (Exit.isFailure(foreign)) expect(Cause.squash(foreign.cause)).toMatchObject({ reason: "missing_binding" })
          yield* Scope.close(scope, Exit.void)
          const late = yield* Effect.exit(permission.assert(request))
          expect(Exit.isFailure(late)).toBe(true)
          if (Exit.isFailure(late)) expect(Cause.squash(late.cause)).toMatchObject({ reason: "missing_binding" })
          const noSource = yield* Effect.exit(permission.ask({ ...request, source: undefined }))
          expect(Exit.isFailure(noSource)).toBe(true)
          if (Exit.isFailure(noSource))
            expect(Cause.squash(noSource.cause)).toMatchObject({ reason: "missing_binding" })
          expect(yield* permission.list()).toEqual([])
          expect(fixture.asked).toHaveLength(0)
        }).pipe(Effect.provide(services(fixture)), Effect.timeout("20 seconds")),
      ),
    )
  },
  25_000,
)

test.skipIf(!binary)(
  "the same captured permission script has matching TS and native outcomes and ask counts",
  async () => {
    const traces = []
    for (const native of [false, true]) {
      await using fixture = await nativeHostSource()
      const trace = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* setup(fixture, native)
            const permission = yield* PermissionV2.Service
            const sources = yield* PermissionSource.Service
            const agents = yield* AgentV2.Service
            const events = yield* EventV2.Service
            yield* agents.transform((editor) =>
              editor.update(AgentV2.ID.make("test"), (agent) => {
                agent.permissions = [
                  { action: "*", resource: "*", effect: "allow" },
                  { action: "read", resource: "*", effect: "ask" },
                  { action: "read", resource: "secret", effect: "deny" },
                ]
              }),
            )
            const source = fixture.request("script", "*").source
            if (source?.type !== "tool") throw new Error("tool source required")
            if (native)
              yield* sources.bind({
                sessionID: fixture.request("script", "*").sessionID,
                source,
                executor: fixture.permission,
              })
            const prompts: PermissionV2.Request[] = []
            const unsubscribe = yield* events.listen((event) =>
              Effect.sync(() => {
                if (event.type === PermissionV2.Event.Asked.type) prompts.push(event.data as PermissionV2.Request)
              }),
            )
            yield* Effect.addFinalizer(() => unsubscribe)
            const outcomes: string[] = []
            const steps = [
              { id: "allowed", resource: "*", action: "noop" },
              { id: "denied", resource: "secret" },
              { id: "once-one", resource: "public", reply: "once" },
              { id: "once-two", resource: "public", reply: "once" },
              { id: "always", resource: "remembered", reply: "always", save: ["remembered"] },
              { id: "remembered", resource: "remembered" },
              { id: "declined", resource: "declined", reply: "reject" },
              { id: "corrected", resource: "corrected", reply: "reject", feedback: "Inspect settings first" },
              { id: "after-rejection", resource: "future", reply: "once" },
            ] as const
            for (const step of steps) {
              const input = fixture.request(step.id, step.resource, {
                ...("action" in step ? { action: step.action } : {}),
                ...("save" in step ? { save: step.save } : {}),
              })
              const fiber = yield* permission.assert(input).pipe(Effect.exit, Effect.forkScoped)
              if ("reply" in step) {
                const message = "feedback" in step ? step.feedback : undefined
                if (native)
                  yield* Effect.promise(async () => fixture.reply(await fixture.wait(step.id), step.reply, message))
                if (!native) {
                  yield* Effect.promise(async () => {
                    const deadline = Date.now() + 5_000
                    while (!prompts.some((request) => request.id === input.id)) {
                      if (Date.now() > deadline) throw new Error(`no TS permission request: ${step.id}`)
                      await Bun.sleep(5)
                    }
                  })
                  yield* permission.reply({ requestID: input.id!, reply: step.reply, message })
                }
              }
              const result = yield* Fiber.join(fiber)
              if (Exit.isSuccess(result)) {
                outcomes.push("allowed")
                continue
              }
              const error = Cause.squash(result.cause)
              if (error instanceof PermissionV2.BlockedError) {
                outcomes.push("blocked")
                continue
              }
              if (error instanceof PermissionV2.DeclinedError) {
                outcomes.push("declined")
                continue
              }
              if (error instanceof PermissionV2.CorrectedError) {
                outcomes.push(`corrected:${error.feedback}`)
                continue
              }
              return yield* Effect.die(error)
            }
            expect(yield* permission.list()).toEqual([])
            return {
              outcomes,
              asks: native ? fixture.asked.map((request) => request.id) : prompts.map((request) => request.id),
            }
          }).pipe(Effect.provide(services(fixture)), Effect.timeout("20 seconds")),
        ),
      )
      traces.push(trace)
    }
    expect(traces[1]).toEqual(traces[0])
    expect(traces[0]).toEqual({
      outcomes: [
        "allowed",
        "blocked",
        "allowed",
        "allowed",
        "allowed",
        "allowed",
        "declined",
        "corrected:Inspect settings first",
        "allowed",
      ],
      asks: ["per_once-one", "per_once-two", "per_always", "per_declined", "per_corrected", "per_after-rejection"],
    })
  },
  45_000,
)

function services(fixture: Awaited<ReturnType<typeof nativeHostSource>>) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      Location.node,
      AgentV2.node,
      PermissionV2.node,
      PermissionSource.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(fixture.directory) })),
        ),
      ],
    ],
  )
}

function setup(fixture: Awaited<ReturnType<typeof nativeHostSource>>, native = true) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const agents = yield* AgentV2.Service
    const sessionID = fixture.request("setup", "*").sessionID
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(fixture.directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    if (native)
      yield* SessionEnginePlacement.claim(database.db, {
        sessionID,
        placement: {
          engine: "rust",
          storage: AbsolutePath.make(fixture.storage),
          location: Location.Ref.make({ directory: AbsolutePath.make(fixture.directory) }),
        },
      }).pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "native",
        directory: fixture.directory,
        title: "Native routing fixture",
        version: "test",
        agent: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      }),
    )
  })
}
