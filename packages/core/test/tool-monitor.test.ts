import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option, Scope } from "effect"
import { BackgroundJob } from "@miao/core/background-job"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionEvent } from "@miao/core/session/event"
import { SessionExecution } from "@miao/core/session/execution"
import { MonitorTool } from "@miao/core/tool/monitor"
import { ToolRegistry } from "@miao/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_monitor_tool_test")

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withMonitor = <A, E>(
  directory: string,
  body: (input: {
    readonly registry: ToolRegistry.Interface
    readonly events: EventV2.Interface
    readonly jobs: BackgroundJob.Interface
  }) => Effect.Effect<A, E, Scope.Scope>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body({
      registry: yield* ToolRegistry.Service,
      events: yield* EventV2.Service,
      jobs: yield* BackgroundJob.Service,
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          MonitorTool.node,
          BackgroundJob.node,
          EventV2.node,
          SessionExecution.node,
        ]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [SessionExecution.node, SessionExecution.noopLayer],
        ],
      ),
    ),
  )
}

const call = (input: typeof MonitorTool.Input.Type, id = "call-monitor") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "monitor", input },
})

const FINAL = ["finished:", "timed out", "could not start"]

const isSynthetic = (event: EventV2.Payload): event is EventV2.Payload<typeof SessionEvent.NotificationAdmitted> =>
  event.type === SessionEvent.NotificationAdmitted.type

/** Records notices for this Session until the monitor's terminal notice arrives. */
const observe = (events: EventV2.Interface) =>
  Effect.gen(function* () {
    const notices: string[] = []
    const finished = yield* Deferred.make<void>()
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!isSynthetic(event) || event.data.sessionID !== sessionID) return
        notices.push(event.data.text)
        if (FINAL.some((marker) => event.data.text.includes(marker)))
          yield* Deferred.succeed(finished, undefined)
      }),
    )
    return { notices, finished: Deferred.await(finished).pipe(Effect.timeoutOption("5 seconds")), unsubscribe }
  })

const withTmp = <A, E>(body: (path: string) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("MonitorTool", () => {
  it.live("returns immediately, delivers only matching lines, and reports the exit", () =>
    withTmp((path) =>
      withMonitor(path, ({ registry, events, jobs }) =>
        Effect.gen(function* () {
          const observed = yield* observe(events)
          yield* Effect.addFinalizer(() => observed.unsubscribe)
          const settled = yield* settleTool(
            registry,
            call({ command: "printf 'ready\\nignored\\n'; sleep 1", pattern: "ready" }),
          )
          expect(settled).toMatchObject({ output: { structured: { jobID: expect.any(String) } } })
          // The command is still sleeping, so the call returned before it finished.
          expect(yield* jobs.list()).toMatchObject([{ type: "monitor", status: "running" }])
          expect(Option.isSome(yield* observed.finished)).toBe(true)
          expect(observed.notices.some((text) => text.includes("ready"))).toBe(true)
          expect(observed.notices.some((text) => text.includes("ignored"))).toBe(false)
          expect(observed.notices.at(-1)).toContain("exited with code 0")
        }),
      ),
    ),
  )

  it.live("reports a non-zero exit code in the final notice", () =>
    withTmp((path) =>
      withMonitor(path, ({ registry, events }) =>
        Effect.gen(function* () {
          const observed = yield* observe(events)
          yield* Effect.addFinalizer(() => observed.unsubscribe)
          yield* settleTool(registry, call({ command: "printf 'noisy\\n'; exit 3" }, "call-monitor-exit"))
          expect(Option.isSome(yield* observed.finished)).toBe(true)
          expect(observed.notices.at(-1)).toContain("exited with code 3")
        }),
      ),
    ),
  )

  it.live("cancels the command and says so when the timeout elapses", () =>
    withTmp((path) =>
      withMonitor(path, ({ registry, events, jobs }) =>
        Effect.gen(function* () {
          const observed = yield* observe(events)
          yield* Effect.addFinalizer(() => observed.unsubscribe)
          yield* settleTool(registry, call({ command: "sleep 30", timeoutMs: 300 }, "call-monitor-timeout"))
          const jobID = (yield* jobs.list())[0].id
          expect(Option.isSome(yield* observed.finished)).toBe(true)
          expect(observed.notices.at(-1)).toContain("timed out after 300 ms")
          // The notice is published before the run settles, so wait for the job.
          expect((yield* jobs.wait({ id: jobID, timeout: 5_000 })).info?.status).toBe("completed")
        }),
      ),
    ),
  )
})
