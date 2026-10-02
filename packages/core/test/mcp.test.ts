import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { ApplicationTools } from "@miao/core/tool/application-tools"
import { Config } from "@miao/core/config"
import { ConfigMCP } from "@miao/core/config/mcp"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { MCP } from "@miao/core/mcp"
import { AgentV2 } from "@miao/core/agent"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionMessage } from "@miao/core/session/message"
import { SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const fixture = path.resolve(import.meta.dir, "fixture/mock-mcp.ts")
const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_mcp")
const agent = AgentV2.ID.make("mcp-test")
const allowAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]

const withMCP = <A, E, R>(
  entries: Config.Entry[],
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  rules = allowAll,
) => {
  const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
  )
  const built = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      MCP.node,
      ToolRegistry.toolsNode,
      ToolRegistry.node,
      ApplicationTools.node,
      ToolOutputStore.node,
    ]),
    [
      [Config.node, config],
      [Location.node, current],
    ],
  )
  return Effect.gen(function* () {
    yield* setup(rules)
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(built))
}

const setup = (rules: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "mcp",
        directory: "/project",
        title: "mcp",
        version: "test",
        agent,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(agent, (item) => {
        item.permissions = [...rules]
      }),
    )
  })

const server = (environment?: Record<string, string>) =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      mcp: new ConfigMCP.Info({
        servers: { mock: new ConfigMCP.Local({ type: "local", command: ["bun", fixture], environment }) },
      }),
    }),
  })

const echo = (registry: ToolRegistry.Interface) =>
  Effect.gen(function* () {
    const materialized = yield* registry.materialize()
    return yield* materialized.settle({
      sessionID,
      agent,
      assistantMessageID: SessionMessage.ID.make("msg_mcp"),
      call: { type: "tool-call", id: "call-mcp", name: "mcp__mock__echo", input: { text: "hi" } },
    })
  })

// Starts an echo call and waits until it is blocked on a permission request.
const echoAwaitingApproval = (registry: ToolRegistry.Interface) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* echo(registry).pipe(Effect.forkScoped)
    return { fiber, request: yield* Deferred.await(asked) }
  })

// The mock server appends each tool it runs to the log file.
const withCallLog = <A, E, R>(
  body: (log: { readonly file: string; readonly calls: () => string[] }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "miao-mcp-calls-"))),
    (dir) => {
      const file = path.join(dir, "calls.log")
      return body({
        file,
        calls: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []),
      })
    },
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

describe("MCP", () => {
  it.live("dedupes canonical tool names deterministically", () =>
    withMCP([server()], (registry) =>
      Effect.gen(function* () {
        const materialized = yield* registry.materialize()
        const names = materialized.definitions.map((definition) => definition.name)
        expect(names.filter((name) => name === "mcp__mock__a_b")).toHaveLength(1)
        // "a.b" sorts before "a_b", so the dot form is the one that wins.
        expect(materialized.definitions.find((definition) => definition.name === "mcp__mock__a_b")?.description).toBe(
          "Dot form",
        )
      }),
    ),
  )

  test("caps oversized image results", () => {
    const parts = MCP.resultContent({
      content: [{ type: "image", data: "A".repeat(MCP.MAX_RESULT_IMAGE_BASE64_BYTES + 1), mimeType: "image/png" }],
    })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(parts[0])).toContain("exceeds")
  })

  test("passes through image results within the cap", () => {
    const parts = MCP.resultContent({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })
    expect(parts).toEqual([{ type: "file", data: "AAAA", mime: "image/png" }])
  })

  test("derives the V1 tool name used by existing permission rules", () => {
    expect(MCP.legacyToolName("my.server", "do-it.now")).toBe("my_server_do-it_now")
  })

  it.live("registers an MCP tool and calls it", () =>
    withMCP([server()], (registry) =>
      Effect.gen(function* () {
        const materialized = yield* registry.materialize()
        expect(materialized.definitions.map((definition) => definition.name)).toContain("mcp__mock__echo")
        expect(JSON.stringify((yield* echo(registry)).result)).toContain("echo:hi")
      }),
    ),
  )

  it.live("asks permission with the server, tool and arguments before calling", () =>
    withCallLog((log) =>
      withMCP(
        [server({ MOCK_MCP_CALL_LOG: log.file })],
        (registry) =>
          Effect.gen(function* () {
            const pending = yield* echoAwaitingApproval(registry)
            expect(pending.request).toMatchObject({
              sessionID,
              action: "mcp__mock__echo",
              resources: ["*"],
              save: ["*"],
              metadata: { server: "mock", tool: "echo", input: { text: "hi" } },
              source: { type: "tool", messageID: "msg_mcp", callID: "call-mcp" },
            })
            expect(log.calls()).toEqual([])
            // `run --auto` and the TUI auto-approve mode answer every request with "once".
            const permission = yield* PermissionV2.Service
            yield* permission.reply({ requestID: pending.request.id, reply: "once" })
            expect(JSON.stringify((yield* Fiber.join(pending.fiber)).result)).toContain("echo:hi")
            expect(log.calls()).toEqual(["echo"])
          }),
        [],
      ),
    ),
  )

  it.live("runs without asking when a rule allows the tool", () =>
    withMCP(
      [server()],
      (registry) =>
        Effect.gen(function* () {
          expect(JSON.stringify((yield* echo(registry)).result)).toContain("echo:hi")
          const permission = yield* PermissionV2.Service
          expect(yield* permission.list()).toEqual([])
        }),
      [
        { action: "*", resource: "*", effect: "ask" },
        { action: "mcp__mock__*", resource: "*", effect: "allow" },
      ],
    ),
  )

  it.live("honors an allow rule written for the V1 tool name", () =>
    withMCP(
      [server()],
      (registry) =>
        Effect.gen(function* () {
          expect(JSON.stringify((yield* echo(registry)).result)).toContain("echo:hi")
        }),
      [
        { action: "*", resource: "*", effect: "ask" },
        { action: "mock_echo", resource: "*", effect: "allow" },
      ],
    ),
  )

  it.live("rejects a denied call without reaching the server", () =>
    withCallLog((log) =>
      withMCP(
        [server({ MOCK_MCP_CALL_LOG: log.file })],
        (registry) =>
          Effect.gen(function* () {
            // The registry is materialized without rules here, so the deny is decided at execution.
            const settlement = yield* echo(registry)
            expect(settlement.result.type).toBe("error")
            expect(JSON.stringify(settlement.result)).toContain("prevents you from using this specific tool call")
            expect(log.calls()).toEqual([])
          }),
        [...allowAll, { action: "mock_*", resource: "*", effect: "deny" }],
      ),
    ),
  )

  it.live("hides tools that a V2 or V1-named rule wholly denies", () =>
    withMCP([server()], (registry) =>
      Effect.gen(function* () {
        const advertised = (rules: PermissionV2.Ruleset) =>
          registry
            .materialize(rules)
            .pipe(
              Effect.map((materialized) =>
                materialized.definitions
                  .map((definition) => definition.name)
                  .filter((name) => name.startsWith("mcp__")),
              ),
            )
        expect(yield* advertised(allowAll)).toContain("mcp__mock__echo")
        expect(yield* advertised([...allowAll, { action: "mcp__mock__*", resource: "*", effect: "deny" }])).toEqual([])
        expect(yield* advertised([...allowAll, { action: "mock_*", resource: "*", effect: "deny" }])).toEqual([])
      }),
    ),
  )

  it.live("returns the user's feedback as a tool error when the call is rejected with a message", () =>
    withCallLog((log) =>
      withMCP(
        [server({ MOCK_MCP_CALL_LOG: log.file })],
        (registry) =>
          Effect.gen(function* () {
            const pending = yield* echoAwaitingApproval(registry)
            const permission = yield* PermissionV2.Service
            yield* permission.reply({ requestID: pending.request.id, reply: "reject", message: "use the cache" })
            expect((yield* Fiber.join(pending.fiber)).result).toEqual({
              type: "error",
              value:
                "The user rejected permission to use this specific tool call with the following feedback: use the cache",
            })
            expect(log.calls()).toEqual([])
          }),
        [],
      ),
    ),
  )

  it.live("halts on a plain rejection like every other tool", () =>
    withCallLog((log) =>
      withMCP(
        [server({ MOCK_MCP_CALL_LOG: log.file })],
        (registry) =>
          Effect.gen(function* () {
            const pending = yield* echoAwaitingApproval(registry)
            const permission = yield* PermissionV2.Service
            yield* permission.reply({ requestID: pending.request.id, reply: "reject" })
            const exit = yield* Fiber.await(pending.fiber)
            expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV2.DeclinedError).toBe(true)
            expect(log.calls()).toEqual([])
          }),
        [],
      ),
    ),
  )
})
