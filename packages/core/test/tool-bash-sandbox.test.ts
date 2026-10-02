import fs from "fs/promises"
import { existsSync, realpathSync } from "node:fs"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import type { ToolContent } from "@miao/llm"
import { Effect, Layer, Queue } from "effect"
import { AgentV2 } from "@miao/core/agent"
import { Config } from "@miao/core/config"
import { ConfigSandbox } from "@miao/core/config/sandbox"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { Location } from "@miao/core/location"
import { LocationMutation } from "@miao/core/location-mutation"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSaved } from "@miao/core/permission/saved"
import { Project } from "@miao/core/project"
import { ProjectTable } from "@miao/core/project/sql"
import { SandboxRunner } from "@miao/core/sandbox/runner"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionTable } from "@miao/core/session/sql"
import { SessionStore } from "@miao/core/session/store"
import { BashTool } from "@miao/core/tool/bash"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_sandbox_test")
const it = testEffect(Layer.empty)

type Answer = { readonly reply: PermissionV2.Reply; readonly message?: string }

// Mirrors the default agent: everything allowed, leaving the workspace or the
// sandbox asks.
const rules: PermissionV2.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: BashTool.UNSANDBOXED_ACTION, resource: "*", effect: "ask" },
]

/**
 * Run `body` against a real PermissionV2 and the bash tool with the sandbox
 * enabled through config. Every permission prompt is recorded and answered by
 * `answer`, the way a user replies through `PermissionV2.reply`.
 */
const withSandboxedBash = <A, E>(input: {
  readonly directory: string
  readonly runner: string | undefined
  readonly sandbox?: ConstructorParameters<typeof ConfigSandbox.Info>[0]
  readonly rules?: PermissionV2.Ruleset
  readonly answer: (request: PermissionV2.Request) => Answer
  readonly body: (tools: {
    readonly run: (command: string, timeout?: number, stdin?: string) => Effect.Effect<Settled, unknown>
    readonly asked: PermissionV2.Request[]
    readonly saved: () => Effect.Effect<readonly { readonly action: string; readonly resource: string }[]>
  }) => Effect.Effect<A, E>
}) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(input.directory) })),
  )
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              sandbox: new ConfigSandbox.Info({ mode: "workspace-write", ...input.sandbox }),
            }),
          }),
        ]),
    }),
  )
  const asked: PermissionV2.Request[] = []
  return withEnv(
    { MIAO_RUN: input.runner, MIAO_SANDBOX: undefined, MIAO_SANDBOX_DENY_NETWORK: undefined },
    Effect.gen(function* () {
      yield* seed(input.directory, input.rules ?? rules)
      const registry = yield* ToolRegistry.Service
      const permission = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const saved = yield* PermissionSaved.Service
      const queue = yield* Queue.unbounded<PermissionV2.Request>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Queue.offer(queue, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Queue.take(queue).pipe(
        Effect.flatMap((request) => {
          asked.push(request)
          return permission.reply({ requestID: request.id, ...input.answer(request) })
        }),
        Effect.forever,
        Effect.forkScoped,
      )
      return yield* input.body({
        run: (command, timeout, stdin) =>
          settleTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call" as const,
              id: `call-${crypto.randomUUID()}`,
              name: "bash",
              input: { command, ...(timeout ? { timeout } : {}), ...(stdin === undefined ? {} : { stdin }) },
            },
          }).pipe(Effect.map(settled)),
        asked,
        saved: () => saved.list({ projectID: Project.ID.global }),
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Database.node,
            EventV2.node,
            SessionStore.node,
            PermissionSaved.node,
            AgentV2.node,
            PermissionV2.node,
            ToolRegistry.node,
            ToolRegistry.toolsNode,
            LocationMutation.node,
            BashTool.node,
          ]),
          [
            [Location.node, activeLocation],
            [Config.node, config],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        ),
      ),
    ),
  )
}

type Settled = {
  readonly text: string
  readonly structured: Record<string, unknown> | undefined
}

const settled = (value: ToolRegistry.Settlement): Settled => ({
  text:
    value.result.type === "content"
      ? value.result.value.map((part: ToolContent) => (part.type === "text" ? part.text : "")).join("\n")
      : JSON.stringify(value.result),
  structured: value.output?.structured as Record<string, unknown> | undefined,
})

const seed = Effect.fnUntraced(function* (directory: string, permissions: PermissionV2.Ruleset) {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "sandbox",
      directory,
      title: "sandbox",
      version: "test",
      agent: toolIdentity.agent,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(toolIdentity.agent, (agent) => {
      agent.permissions = [...permissions]
    }),
  )
})

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const withTmp = <A, E>(body: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

/**
 * A fake sandbox runner that speaks the runner CLI. It "blocks" writes to
 * `blocked` (or, with no `blocked`, a pathless network-style denial) unless
 * the tool passed that directory as writable, and logs every invocation.
 */
const fakeRunner = Effect.fnUntraced(function* (directory: string, blocked: string | undefined) {
  const file = path.join(directory, "fake-run.sh")
  const log = path.join(directory, "fake-run.log")
  const deny = blocked
    ? `echo "sh: ${blocked}/f.txt: Operation not permitted" >&2
printf '{"denied":["%s"],"exitCode":1}' "${blocked}/f.txt" > "$report"`
    : `echo "connect: Operation not permitted" >&2
printf '{"denied":[],"exitCode":1}' > "$report"`
  yield* Effect.promise(() =>
    fs.writeFile(
      file,
      `#!/bin/sh
allowed="|"
report=""
printf '%s\\n' "$*" >> "${log}"
while [ $# -gt 0 ]; do
  case "$1" in
    --workdir|--allow-path) allowed="$allowed$2|"; shift 2 ;;
    --deny-report) report="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
case "$allowed" in
  *"|${blocked ?? "/never-allowed"}|"*) exec "$@" ;;
esac
${deny}
exit 1
`,
      { mode: 0o755 },
    ),
  )
  return {
    file,
    runs: () =>
      Effect.promise(() =>
        fs
          .readFile(log, "utf8")
          .then((text) => text.trim().split("\n"))
          .catch(() => []),
      ),
  }
})

const fakeBlocked = () => `/miao-sandbox-test-${crypto.randomUUID()}`

describe.skipIf(process.platform === "win32" || SandboxRunner.backend() === undefined)("BashTool sandbox", () => {
  it.live("allows a blocked directory after external_directory approval and reruns", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const blocked = fakeBlocked()
        const runner = yield* fakeRunner(directory, blocked)
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          answer: () => ({ reply: "always" }),
          body: (tools) =>
            Effect.gen(function* () {
              const first = yield* tools.run("printf sandboxed-ok")
              expect(first.text).toContain("sandboxed-ok")
              expect(first.text).toContain("Command exited with code 0.")
              expect(first.structured?.sandbox).toEqual({
                state: "sandboxed",
                backend: SandboxRunner.backend(),
                network: true,
                denied: [],
                approved: [blocked],
              })
              expect(tools.asked.map((request) => [request.action, request.resources])).toEqual([
                ["external_directory", [`${blocked}/*`]],
              ])
              const runs = yield* runner.runs()
              expect(runs).toHaveLength(2)
              // Location, temp directory, and network flags reach the runner.
              expect(runs[0]).toContain(`--workdir ${realpathSync(directory)}`)
              expect(runs[0]).toContain(`--allow-path ${realpathSync(os.tmpdir())}`)
              expect(runs[0]).toContain("--allow-network")
              expect(runs[1]).toContain(`--allow-path ${blocked}`)
              expect(yield* tools.saved()).toContainEqual(
                expect.objectContaining({ action: "external_directory", resource: `${blocked}/*` }),
              )

              // The saved approval answers the next denial without a prompt.
              const second = yield* tools.run("printf again")
              expect(second.text).toContain("again")
              expect(tools.asked).toHaveLength(1)
            }),
        })
      }),
    ),
  )

  it.live("still asks before escalating when the only rule is a catch-all allow", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const blocked = fakeBlocked()
        const runner = yield* fakeRunner(directory, blocked)
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          rules: [{ action: "*", resource: "*", effect: "allow" }],
          answer: () => ({ reply: "reject" }),
          body: (tools) =>
            Effect.gen(function* () {
              const result = yield* tools.run("printf sandboxed-ok")
              expect(tools.asked.map((request) => request.action)).toEqual([
                "external_directory",
                BashTool.UNSANDBOXED_ACTION,
              ])
              expect(result.structured?.sandbox).toMatchObject({ state: "sandboxed", approved: [] })
            }),
        })
      }),
    ),
  )

  it.live("reruns once without the sandbox when the path is declined and escape is approved", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const blocked = fakeBlocked()
        const runner = yield* fakeRunner(directory, blocked)
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          answer: (request) => (request.action === "external_directory" ? { reply: "reject" } : { reply: "always" }),
          body: (tools) =>
            Effect.gen(function* () {
              const first = yield* tools.run("printf escaped")
              expect(first.text).toContain("escaped")
              expect(first.text).toContain("rerun without the sandbox")
              expect(first.structured?.sandbox).toMatchObject({ state: "unsandboxed", denied: [`${blocked}/f.txt`] })
              expect(tools.asked.map((request) => request.action)).toEqual([
                "external_directory",
                BashTool.UNSANDBOXED_ACTION,
              ])
              expect(tools.asked[1]?.resources).toEqual(["printf escaped"])
              expect(tools.asked[1]?.save).toBeUndefined()
              expect(yield* runner.runs()).toHaveLength(1)

              // "always" on the escape is not remembered: the next command asks again.
              yield* tools.run("printf twice")
              expect(tools.asked.map((request) => request.action)).toEqual([
                "external_directory",
                BashTool.UNSANDBOXED_ACTION,
                "external_directory",
                BashTool.UNSANDBOXED_ACTION,
              ])
              expect((yield* tools.saved()).filter((rule) => rule.action === BashTool.UNSANDBOXED_ACTION)).toEqual([])
            }),
        })
      }),
    ),
  )

  it.live("keeps the sandboxed result with a warning when both escalations are declined", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const blocked = fakeBlocked()
        const runner = yield* fakeRunner(directory, blocked)
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          answer: (request) =>
            request.action === "external_directory"
              ? { reply: "reject" }
              : { reply: "reject", message: "use the workspace cache" },
          body: (tools) =>
            Effect.gen(function* () {
              const result = yield* tools.run("printf never")
              expect(result.text).not.toContain("never")
              expect(result.text).toContain(`The OS sandbox blocked writes to: ${blocked}/f.txt.`)
              expect(result.text).toContain("The command was not rerun outside the sandbox.")
              expect(result.text).toContain("User feedback: use the workspace cache")
              expect(result.text).toContain("Command exited with code 1.")
              expect(result.structured).toMatchObject({
                exit: 1,
                sandbox: { state: "sandboxed", denied: [`${blocked}/f.txt`], approved: [] },
              })
              expect(yield* runner.runs()).toHaveLength(1)
            }),
        })
      }),
    ),
  )

  it.live("asks to leave the sandbox directly for a denial without a path", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const runner = yield* fakeRunner(directory, undefined)
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          sandbox: { network: false },
          answer: () => ({ reply: "once" }),
          body: (tools) =>
            Effect.gen(function* () {
              const result = yield* tools.run("printf networked")
              expect(result.text).toContain("networked")
              expect(tools.asked.map((request) => request.action)).toEqual([BashTool.UNSANDBOXED_ACTION])
              expect(tools.asked[0]?.metadata).toMatchObject({ unmapped: ["connect: Operation not permitted"] })
              expect((yield* runner.runs())[0]).not.toContain("--allow-network")
            }),
        })
      }),
    ),
  )

  it.live("pipes stdin through the sandbox runner", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const runner = yield* fakeRunner(directory, realpathSync(directory))
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          answer: () => ({ reply: "once" }),
          body: (tools) =>
            Effect.gen(function* () {
              const stdin = "printf '%s' \"$((6 * 7)) `echo tick`\"\n"
              const result = yield* tools.run("bash -s", undefined, stdin)
              expect(result.text).toBe("42 tick\nCommand exited with code 0.")
              expect(result.structured).toMatchObject({ exit: 0, sandbox: { state: "sandboxed" } })
              expect(yield* runner.runs()).toHaveLength(1)
            }),
        })
      }),
    ),
  )

  it.live("does not escalate an ordinary failing command", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        // The runner allows everything under the Location, so the command runs.
        const runner = yield* fakeRunner(directory, realpathSync(directory))
        yield* withSandboxedBash({
          directory,
          runner: runner.file,
          answer: () => ({ reply: "once" }),
          body: (tools) =>
            Effect.gen(function* () {
              const result = yield* tools.run("echo plain failure >&2; exit 3")
              expect(result.structured).toMatchObject({ exit: 3, sandbox: { state: "sandboxed", denied: [] } })
              expect(tools.asked).toEqual([])
            }),
        })
      }),
    ),
  )
})

describe.skipIf(process.platform === "win32" || SandboxRunner.backend() === undefined)(
  "BashTool stdin approval",
  () => {
    // Bash asks unless a rule says otherwise; the fake runner runs everything.
    const asking: PermissionV2.Ruleset = [...rules, { action: "bash", resource: "*", effect: "ask" }]

    it.live("shows the script in the request and remembers it only for the same script", () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          const runner = yield* fakeRunner(directory, realpathSync(directory))
          yield* withSandboxedBash({
            directory,
            runner: runner.file,
            rules: asking,
            answer: () => ({ reply: "always" }),
            body: (tools) =>
              Effect.gen(function* () {
                const script = "SELECT * FROM t\n"
                const first = yield* tools.run("cat", undefined, script)
                expect(first.text).toBe("SELECT * FROM t\n\nCommand exited with code 0.")
                expect(tools.asked).toHaveLength(1)
                expect(tools.asked[0]?.action).toBe("bash")
                expect(tools.asked[0]?.resources[0]).toBe(`cat \n<<stdin\n${script}`)
                expect(tools.asked[0]?.metadata).toEqual({ command: "cat", stdin: script })
                expect(yield* tools.saved()).toContainEqual(
                  expect.objectContaining({ action: "bash", resource: `cat \n<<stdin\n${script}` }),
                )

                // The same command and script reuse the saved approval.
                yield* tools.run("cat", undefined, script)
                expect(tools.asked).toHaveLength(1)

                // A different script asks again, even one the saved text would match as a pattern.
                yield* tools.run("cat", undefined, "SELECT 1; DROP TABLE t; -- FROM t\n")
                expect(tools.asked).toHaveLength(2)
                yield* tools.run("cat", undefined, "something else\n")
                expect(tools.asked).toHaveLength(3)

                // The command alone, without stdin, is a different request too.
                yield* tools.run("cat")
                expect(tools.asked).toHaveLength(4)
                expect(tools.asked[3]?.resources).toEqual(["cat"])
              }),
          })
        }),
      ),
    )

    it.live("keeps the saved command rule without stdin working as before", () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          const runner = yield* fakeRunner(directory, realpathSync(directory))
          yield* withSandboxedBash({
            directory,
            runner: runner.file,
            rules: asking,
            answer: () => ({ reply: "always" }),
            body: (tools) =>
              Effect.gen(function* () {
                yield* tools.run("printf one")
                yield* tools.run("printf one")
                expect(tools.asked.map((request) => [request.resources, request.save])).toEqual([
                  [["printf one"], ["printf one"]],
                ])
              }),
          })
        }),
      ),
    )

    it.live("lets a pattern rule cover any stdin", () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          const runner = yield* fakeRunner(directory, realpathSync(directory))
          yield* withSandboxedBash({
            directory,
            runner: runner.file,
            rules: [...asking, { action: "bash", resource: "cat *", effect: "allow" }],
            answer: () => ({ reply: "reject" }),
            body: (tools) =>
              Effect.gen(function* () {
                const result = yield* tools.run("cat", undefined, "any script\n")
                expect(result.text).toBe("any script\n\nCommand exited with code 0.")
                yield* tools.run("cat -", undefined, "another\n")
                expect(tools.asked).toEqual([])
              }),
          })
        }),
      ),
    )

    it.live("applies a deny rule to the script as well as the command", () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          const runner = yield* fakeRunner(directory, realpathSync(directory))
          yield* withSandboxedBash({
            directory,
            runner: runner.file,
            rules: [...rules, { action: "bash", resource: "*rm -rf*", effect: "deny" }],
            answer: () => ({ reply: "once" }),
            body: (tools) =>
              Effect.gen(function* () {
                const result = yield* tools.run("bash -s", undefined, "rm -rf ./build\n")
                expect(result.text).not.toContain("Command exited")
                expect(yield* runner.runs()).toEqual([])
              }),
          })
        }),
      ),
    )
  },
)

// End-to-end against the real kernel sandbox: the built `miao-run` binary when
// present, otherwise the source runner through the native addon.
const builtRunner = path.join(import.meta.dir, "../../../crates/miao-native/target/release/miao-run")
const realRunner = existsSync(builtRunner) ? builtRunner : undefined
const realAvailable =
  process.platform === "darwin" &&
  SandboxRunner.backend() === "seatbelt" &&
  (realRunner !== undefined || withoutRunEnv(() => SandboxRunner.resolve()) !== undefined)

function withoutRunEnv<A>(body: () => A) {
  const previous = process.env.MIAO_RUN
  delete process.env.MIAO_RUN
  try {
    return body()
  } finally {
    if (previous !== undefined) process.env.MIAO_RUN = previous
  }
}

describe.skipIf(!realAvailable)("BashTool sandbox (macOS seatbelt)", () => {
  it.live("allows writes inside the working directory", () =>
    withTmp((directory) =>
      withSandboxedBash({
        directory,
        runner: realRunner,
        answer: () => ({ reply: "reject" }),
        body: (tools) =>
          Effect.gen(function* () {
            const result = yield* tools.run("echo inside > inside.txt && cat inside.txt")
            expect(result.text).toContain("inside")
            expect(result.structured).toMatchObject({ exit: 0, sandbox: { state: "sandboxed" } })
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "inside.txt"), "utf8"))).toBe(
              "inside\n",
            )
            expect(tools.asked).toEqual([])
          }),
      }),
    ),
  )

  it.live("blocks a write in the home directory until the directory is approved", () => {
    const target = path.join(os.homedir(), `.miao-sbx-${crypto.randomUUID()}`)
    return withTmp((directory) =>
      withSandboxedBash({
        directory,
        runner: realRunner,
        answer: () => ({ reply: "once" }),
        body: (tools) =>
          Effect.gen(function* () {
            const result = yield* tools.run(`echo home > "${target}" && cat "${target}"`)
            expect(result.text).toContain("home")
            expect(result.structured).toMatchObject({
              exit: 0,
              sandbox: { state: "sandboxed", approved: [realpathSync(os.homedir())] },
            })
            expect(tools.asked.map((request) => [request.action, request.resources])).toEqual([
              ["external_directory", [`${realpathSync(os.homedir())}/*`]],
            ])
          }),
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => fs.rm(target, { force: true }))))
  })

  it.live("keeps a home directory write blocked when every escalation is declined", () => {
    const target = path.join(os.homedir(), `.miao-sbx-${crypto.randomUUID()}`)
    return withTmp((directory) =>
      withSandboxedBash({
        directory,
        runner: realRunner,
        answer: () => ({ reply: "reject" }),
        body: (tools) =>
          Effect.gen(function* () {
            const result = yield* tools.run(`echo home > "${target}"`)
            expect(result.structured).toMatchObject({ sandbox: { state: "sandboxed" } })
            expect(result.text).toContain("The OS sandbox blocked writes to:")
            expect(existsSync(target)).toBe(false)
          }),
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => fs.rm(target, { force: true }))))
  })

  it.live("denies network connections when sandbox.network is false", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const hits: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            hits.push(request.url)
            return new Response("reached")
          },
        })
        return { server, hits }
      }),
      (listener) =>
        withTmp((directory) =>
          withSandboxedBash({
            directory,
            runner: realRunner,
            sandbox: { network: false },
            answer: () => ({ reply: "reject" }),
            body: (tools) =>
              Effect.gen(function* () {
                const result = yield* tools.run(`curl -sS http://127.0.0.1:${listener.server.port}/`)
                expect(result.text).not.toContain("reached")
                expect(result.structured).toMatchObject({ sandbox: { state: "sandboxed", network: false } })
                expect(result.structured?.exit).not.toBe(0)
                expect(listener.hits).toEqual([])
                expect(tools.asked.map((request) => request.action)).toEqual([BashTool.UNSANDBOXED_ACTION])
              }),
          }),
        ),
      (listener) => Effect.promise(() => listener.server.stop(true)),
    ),
  )

  it.live("delivers stdin to a sandboxed command", () =>
    withTmp((directory) =>
      withSandboxedBash({
        directory,
        runner: realRunner,
        answer: () => ({ reply: "reject" }),
        body: (tools) =>
          Effect.gen(function* () {
            const script = "cat <<'EOF' > inside.txt\n$HOME `id` 'q' \"dq\" 中文\nEOF\ncat inside.txt\n"
            const result = yield* tools.run("bash -s", undefined, script)
            expect(result.text).toBe("$HOME `id` 'q' \"dq\" 中文\n\nCommand exited with code 0.")
            expect(result.structured).toMatchObject({ exit: 0, sandbox: { state: "sandboxed" } })
            expect(tools.asked).toEqual([])
          }),
      }),
    ),
  )

  it.live("kills the sandboxed process group on timeout", () =>
    withTmp((directory) =>
      withSandboxedBash({
        directory,
        runner: realRunner,
        answer: () => ({ reply: "reject" }),
        body: (tools) =>
          Effect.gen(function* () {
            const result = yield* tools.run("sleep 30 & echo $! > child.pid; wait", 1_000)
            expect(result.structured).toMatchObject({ timeout: true, sandbox: { state: "sandboxed" } })
            const pid = Number(yield* Effect.promise(() => fs.readFile(path.join(directory, "child.pid"), "utf8")))
            expect(pid).toBeGreaterThan(0)
            yield* Effect.sleep("500 millis")
            expect(alive(pid)).toBe(false)
          }),
      }),
    ),
  )
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
