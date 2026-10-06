import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Config } from "@miao/core/config"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { PermissionV2 } from "@miao/core/permission"
import { Pty } from "@miao/core/pty"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { TerminalTool } from "@miao/core/tool/terminal"
import { ToolRegistry } from "@miao/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_terminal_tool_test")

const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.suspend(() =>
        input.action === denyAction
          ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
          : Effect.sync(() => assertions.push(input)),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const config = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })

const withTerminals = <A, E>(
  directory: string,
  body: (input: { readonly registry: ToolRegistry.Interface; readonly pty: Pty.Interface }) => Effect.Effect<
    A,
    E,
    Scope.Scope
  >,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body({ registry: yield* ToolRegistry.Service, pty: yield* Pty.Service })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, TerminalTool.node, Pty.node, EventV2.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [Config.node, config],
        ],
      ),
    ),
  )
}

const call = (name: string, input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

const settle = <A>(registry: ToolRegistry.Interface, name: string, input: unknown) =>
  settleTool(registry, call(name, input)).pipe(
    Effect.flatMap((settlement) =>
      settlement.result.type === "error"
        ? Effect.fail(new Error(`tool ${name} failed: ${settlement.result.value}`))
        : Effect.succeed(settlement.output?.structured as A),
    ),
  )

const failure = (registry: ToolRegistry.Interface, name: string, input: unknown) =>
  settleTool(registry, call(name, input))

/** Reads until the accumulated text satisfies the predicate; each read is a delta. */
const readUntil = (
  registry: ToolRegistry.Interface,
  id: string,
  done: (result: { output: string; status: string; exitCode?: number }, accumulated: string) => boolean,
) =>
  Effect.gen(function* () {
    let accumulated = ""
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = yield* settle<TerminalToolReadOutput>(registry, "terminal_read", { id })
      accumulated += result.output
      if (done(result, accumulated)) return { ...result, accumulated }
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.fail(new Error(`timeout reading terminal output: ${JSON.stringify(accumulated)}`))
  })

type TerminalToolReadOutput = typeof TerminalTool.ReadOutput.Type

const waitForExit = (registry: ToolRegistry.Interface, id: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const listed = yield* settle<typeof TerminalTool.ListOutput.Type>(registry, "terminal_list", {})
      const info = listed.terminals.find((terminal) => terminal.id === id)
      if (info?.status === "exited") {
        // The status flips on the process's exit notification; give the final
        // read of its output the same moment the tool would have.
        yield* Effect.sleep("100 millis")
        return info
      }
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.fail(new Error(`timeout waiting for ${id} to exit`))
  })

const withTmp = <A, E>(body: (path: string) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)
const terminalTest = process.platform === "win32" ? it.live.skip : it.live

describe("TerminalTool", () => {
  beforeEach(() => {
    assertions.length = 0
    denyAction = undefined
  })

  terminalTest("starts a terminal, writes to it, and reads the response back", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          // `env` is not a known shell name, so the spawn gets no login argument
          // and the arguments reach `sh` exactly as written.
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "cat"],
          })
          expect(started).toMatchObject({ status: "running", command: "/usr/bin/env", cwd: path })

          yield* settle(registry, "terminal_write", { id: started.id, input: "AAA\n" })
          const read = yield* readUntil(registry, started.id, (_result, accumulated) => accumulated.includes("AAA\nAAA\n"))

          // The terminal echoes the input and `cat` writes it back. Both copies
          // arrive as CRLF, and both are normalized on the way out.
          expect(read.accumulated).toBe("AAA\nAAA\n")
          expect(read.status).toBe("running")
        }),
      ),
    ),
  )

  terminalTest("strips the escape sequences an interactive program emits", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "printf '\\033[31mRED\\033[0m\\n'; sleep 30"],
          })
          const read = yield* readUntil(registry, started.id, (result) => result.output.includes("RED"))

          expect(read.accumulated).toBe("RED\n")
          expect(read.accumulated).not.toContain("\u001b")
        }),
      ),
    ),
  )

  terminalTest("reads the tail of an exited terminal and reports its exit code", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "printf 'BYE\\n'; exit 7"],
          })
          yield* waitForExit(registry, started.id)

          const read = yield* settle<TerminalToolReadOutput>(registry, "terminal_read", { id: started.id })
          expect(read).toMatchObject({ status: "exited", exitCode: 7 })
          expect(read.output).toContain("BYE")
        }),
      ),
    ),
  )

  terminalTest("reports writing to an exited terminal instead of succeeding silently", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "exit 0"],
          })
          yield* waitForExit(registry, started.id)

          const settled = yield* failure(registry, "terminal_write", { id: started.id, input: "AAA\n" })
          // `Pty.write` ignores an exited Session, so this has to be caught here.
          expect(settled).toMatchObject({
            result: { type: "error", value: expect.stringContaining("has exited") },
          })
        }),
      ),
    ),
  )

  terminalTest("lists the terminals of a location and removes one on stop", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const first = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "cat"],
            title: "first",
          })
          const second = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "printf 'TAIL\\n'"],
          })
          yield* waitForExit(registry, second.id)

          const listed = yield* settle<typeof TerminalTool.ListOutput.Type>(registry, "terminal_list", {})
          expect(listed.terminals.map((terminal) => [terminal.id, terminal.status, terminal.title])).toEqual([
            [first.id, "running", "first"],
            [second.id, "exited", expect.any(String)],
          ])

          // The exited terminal still holds output nobody has read; stopping it
          // returns that tail rather than discarding it.
          const stopped = yield* settle<typeof TerminalTool.StopOutput.Type>(registry, "terminal_stop", {
            id: second.id,
          })
          expect(stopped).toMatchObject({ status: "exited" })
          expect(stopped.output).toContain("TAIL")

          const after = yield* settle<typeof TerminalTool.ListOutput.Type>(registry, "terminal_list", {})
          expect(after.terminals.map((terminal) => terminal.id)).toEqual([first.id])
          const gone = yield* failure(registry, "terminal_read", { id: second.id })
          expect(gone).toMatchObject({
            result: { type: "error", value: expect.stringContaining("Unknown terminal") },
          })
        }),
      ),
    ),
  )

  terminalTest("checks the spawn command against bash and the terminal itself, explicitly", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "cat"],
          })
          expect(assertions.map((input) => [input.action, input.resources, input.explicit])).toEqual([
            ["bash", ["/usr/bin/env"], true],
            ["terminal", ["*"], true],
          ])

          // Every later call is checked against the same action, so an answer
          // saved for the start covers the family and none of them re-checks
          // bash — nothing typed into a terminal is a command this layer knows.
          assertions.length = 0
          yield* settle(registry, "terminal_write", { id: started.id, input: "AAA\n" })
          yield* settle(registry, "terminal_read", { id: started.id })
          yield* settle(registry, "terminal_list", {})
          yield* settle(registry, "terminal_stop", { id: started.id })
          expect(assertions.map((input) => [input.action, input.resources, input.explicit])).toEqual([
            ["terminal", ["*"], true],
            ["terminal", ["*"], true],
            ["terminal", ["*"], true],
            ["terminal", ["*"], true],
          ])

          // Without a command the configured shell stands in, which this layer
          // does not resolve: `*` is what the bash rule is matched against.
          assertions.length = 0
          yield* settle(registry, "terminal_start", { args: [] })
          expect(assertions[0]).toMatchObject({ action: "bash", resources: ["*"], explicit: true })
        }),
      ),
    ),
  )

  terminalTest("refuses to reach a terminal when the terminal action is denied", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const started = yield* settle<typeof TerminalTool.StartOutput.Type>(registry, "terminal_start", {
            command: "/usr/bin/env",
            args: ["sh", "-c", "cat"],
          })

          denyAction = "terminal"
          const blocked = yield* failure(registry, "terminal_write", { id: started.id, input: "AAA\n" })
          denyAction = undefined
          expect(blocked.result.type).toBe("error")
        }),
      ),
    ),
  )

  it.live("hides the terminal family behind a rule that names its action", () =>
    withTmp((path) =>
      withTerminals(path, ({ registry }) =>
        Effect.gen(function* () {
          const names = (rules?: PermissionV2.Ruleset) =>
            toolDefinitions(registry, rules).pipe(Effect.map((tools) => tools.map((tool) => tool.name).sort()))

          const family = ["terminal_list", "terminal_read", "terminal_start", "terminal_stop", "terminal_write"]
          expect(yield* names()).toEqual(family)

          // The family is one action, not `bash`: denying bash leaves it alone,
          // and denying `terminal` takes all five out at once.
          expect(yield* names([{ action: "bash", resource: "*", effect: "deny" }])).toEqual(family)
          expect(yield* names([{ action: "terminal", resource: "*", effect: "deny" }])).toEqual([])
        }),
      ),
    ),
  )
})
