import fs from "fs/promises"
import { existsSync, realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import type { ToolContent } from "@miao/llm"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@miao/core/fs-util"
import { Config } from "@miao/core/config"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Location } from "@miao/core/location"
import { LocationMutation } from "@miao/core/location-mutation"
import { PermissionV2 } from "@miao/core/permission"
import { AppProcess } from "@miao/core/process"
import { BackgroundJob } from "@miao/core/background-job"
import { EventV2 } from "@miao/core/event"
import { AbsolutePath } from "@miao/core/schema"
import { SessionV2 } from "@miao/core/session"
import { SessionExecution } from "@miao/core/session/execution"
import { ShellEnvironment } from "@miao/core/shell/environment"
import { BashTool } from "@miao/core/tool/bash"
import { ToolRegistry } from "@miao/core/tool/registry"
import { ToolOutputStore } from "@miao/core/tool-output-store"
import { Hash } from "@miao/core/util/hash"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly env?: Record<string, string | undefined>
  readonly extendEnv?: boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: AppProcess.AppProcessError | undefined
const published: Array<{ readonly type: string; readonly data: unknown }> = []
// `<shell> -n -c <command>` syntax checks, kept apart from the command runs.
const checks: Array<{ readonly shell: string; readonly args: readonly string[] }> = []
let checkResult: AppProcess.RunResult | undefined
let configuredShell: string | undefined
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void
// What an installed `shell.env` source returns, and the inputs it was asked with.
let pluginEnv: Record<string, string> = {}
const pluginEnvInputs: ShellEnvironment.Input[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        if (command.args[0] === "-n") {
          checks.push({ shell: command.command, args: command.args })
          return Effect.succeed(checkResult ?? { ...result, exitCode: 0, output: Buffer.alloc(0) })
        }
        runs.push({
          command: command.command,
          cwd: command.options.cwd,
          shell: command.options.shell,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
          options,
        })
        return runFailure ? Effect.fail(runFailure) : Effect.succeed(result)
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.sync(() =>
        configuredShell === undefined
          ? []
          : [new Config.Document({ type: "document", info: new Config.Info({ shell: configuredShell }) })],
      ),
  }),
)
const eventV2 = Layer.succeed(
  EventV2.Service,
  {
    publish: (definition: { type: string }, data: unknown) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return {} as never
      }),
  } as unknown as EventV2.Interface,
)
const woken: Array<string> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  {
    wake: (sessionID: SessionV2.ID) =>
      Effect.sync(() => {
        woken.push(sessionID)
      }),
  } as unknown as SessionExecution.Interface,
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  woken.length = 0
  denyAction = undefined
  runFailure = undefined
  checks.length = 0
  checkResult = undefined
  configuredShell = undefined
  afterPermission = () => Effect.void
  pluginEnv = {}
  pluginEnvInputs.length = 0
  published.length = 0
  result = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

// The real ShellEnvironment with one installed source, as the plugin host installs it.
const shellEnvironment = Layer.effect(
  ShellEnvironment.Service,
  Effect.gen(function* () {
    const environment = yield* ShellEnvironment.Service
    yield* environment.install((input) =>
      Effect.sync(() => {
        pluginEnvInputs.push(input)
        return { ...pluginEnv }
      }),
    )
    return environment
  }),
).pipe(Layer.provide(ShellEnvironment.layer))

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node, BackgroundJob.node, EventV2.node, SessionExecution.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, processLayer],
          [Config.node, config],
          [EventV2.node, eventV2],
          [SessionExecution.node, execution],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [ShellEnvironment.node, shellEnvironment],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)
const liveIf = (condition: boolean) => (condition ? it.live : it.live.skip)

describe("BashTool", () => {
  it.live("durably announces the background job lifecycle", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* settleTool(registry, call({ command: "echo hi", run_in_background: true }, "call-bg-lifecycle"))
            const deadline = Date.now() + 5_000
            while (published.length < 2 && Date.now() < deadline) yield* Effect.sleep("10 millis")
            expect(published.map((entry) => entry.type)).toEqual([
              "session.next.synthetic",
              "session.next.notification.admitted",
            ])
            const started = published[0]!.data as { metadata: { backgroundJob: { status: string } } }
            expect(started.metadata.backgroundJob.status).toBe("started")
            const settled = published[1]!.data as {
              text: string
              metadata: { backgroundJob: { status: string; command: string } }
            }
            expect(settled.metadata.backgroundJob.status).toBe("finished")
            expect(settled.metadata.backgroundJob.command).toBe("echo hi")
            expect(settled.text).toContain("[exit code 0]")
            // The settlement wakes the session so an idle drain cannot strand it.
            expect(woken).toEqual([sessionID])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("starts a bash command as a background job owned by the session", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* settleTool(registry, call({ command: "echo hi", run_in_background: true }, "call-background"))
            const jobs = yield* BackgroundJob.Service
            const listed = yield* jobs.list()
            expect(listed).toHaveLength(1)
            const job = listed[0]!
            expect(job.type).toBe("bash")
            expect(job.metadata?.sessionID).toBe(sessionID)
            const settled = yield* jobs.wait({ id: job.id, timeout: 5_000 })
            expect(settled.timedOut).toBe(false)
            expect(settled.info?.status).toBe("completed")
            expect(settled.info?.output).toContain("[exit code 0]")
            const outputPath = job.metadata?.outputPath
            if (typeof outputPath !== "string") throw new Error("Background output path was not recorded")
            expect(runs[0]?.options?.outputFile).toBe(outputPath)
            expect(runs[0]?.options?.outputFileMaxBytes).toBe(BashTool.MAX_STREAM_BYTES)
            expect(settled.info?.output).toContain(`Captured output: ${outputPath}`)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.description")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.output")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.command")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "[exit code 0]" },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "[exit code 0]" },
                ],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            expect(runs[0]?.options).toMatchObject({
              combineOutput: true,
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd *"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "[exit code 0]" },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("warns on foreground open-ended waits without blocking the run", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          settleTool(registry, call({ command: "gh pr checks 12 --watch" }, "call-blocking-wait")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({ exit: 0 })
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringMatching(/Warnings:[\s\S]*open-ended wait[\s\S]*gh run watch/),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("does not warn on ordinary foreground commands", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "echo hi" }, "call-plain"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.not.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("does not advise background open-ended waits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          settleTool(registry, call({ command: "gh pr checks 12 --watch", run_in_background: true }, "call-bg-wait")),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ jobID: expect.any(String) })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("started in the background"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]().then(() => undefined)),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("[exit code 7]"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, outputTruncated: true }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

describe("BashTool shell.env", () => {
  it.live("layers plugin shell.env variables over the inherited environment", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        pluginEnv = { MIAO_PLUGIN_VAR: "from-plugin" }
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "env", workdir: "." }, "call-env")),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toMatchObject([{ env: { MIAO_PLUGIN_VAR: "from-plugin" }, extendEnv: true }])
              // The syntax check parses under the same environment as the run.
              expect(pluginEnvInputs).toEqual([
                {
                  directory: tmp.path,
                  cwd: realpathSync(tmp.path),
                  sessionID,
                  callID: "call-env",
                },
              ])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("leaves the process environment untouched when no plugin adds variables", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => executeTool(registry, call({ command: "env" }))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(runs[0]?.env).toBeUndefined()
              expect(runs[0]?.extendEnv).toBeUndefined()
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

describe("BashTool stdin and permissions", () => {
  it.live("approves the command together with the full stdin and its digest", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const stdin = "echo 'hi' \"$HOME\" `date`\n"
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "ssh host 'bash -s'", stdin })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const resources = [
                `ssh host 'bash -s' \n<<stdin\n${stdin}`,
                `ssh host 'bash -s' \n<<stdin sha256:${Hash.sha256(stdin)}`,
              ]
              expect(assertions).toEqual([
                expect.objectContaining({
                  action: "bash",
                  resources,
                  save: resources,
                  metadata: { command: "ssh host 'bash -s'", stdin },
                }),
              ])
              expect(runs).toHaveLength(1)
              expect(runs[0]?.options?.stdin).toBe(stdin)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  liveIf(process.platform !== "win32")("approves a command without stdin by command, saving its BashArity prefix", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => executeTool(registry, call({ command: "git status" }))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions).toHaveLength(1)
              expect(assertions[0]?.resources).toEqual(["git status"])
              expect(assertions[0]?.save).toEqual(["git status *"])
              expect(assertions[0]).not.toHaveProperty("metadata")
              expect(runs[0]?.options).not.toHaveProperty("stdin")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  liveIf(process.platform !== "win32")("splits a compound command into one resource and one prefix rule per command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: 'git add . && git commit -m "wip" | cat' })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions[0]?.resources).toEqual(["git add .", 'git commit -m "wip"', "cat"])
              expect(assertions[0]?.save).toEqual(["git add *", "git commit *", "cat *"])
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps exact approval for a command with stdin, never a prefix rule", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "git status && psql", stdin: "select 1;" })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const resources = [
                "git status && psql \n<<stdin\nselect 1;",
                `git status && psql \n<<stdin sha256:${Hash.sha256("select 1;")}`,
              ]
              expect(assertions[0]?.resources).toEqual(resources)
              expect(assertions[0]?.save).toEqual(resources)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("guards a stdin-free command that spells out the stdin marker", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const command = "ssh host 'bash -s' \n<<stdin\necho hi"
        return withTool(tmp.path, (registry) => executeTool(registry, call({ command }))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions[0]?.resources).toEqual([command, `<<no-stdin\n${command}`])
              expect(assertions[0]?.save).toEqual([command, `<<no-stdin\n${command}`])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects stdin over the limit before asking or running", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          executeTool(registry, call({ command: "cat", stdin: "x".repeat(BashTool.MAX_STDIN_BYTES + 1) })),
        ).pipe(
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: `stdin is ${BashTool.MAX_STDIN_BYTES + 1} bytes, over the ${BashTool.MAX_STDIN_BYTES}-byte limit. The command was not run.`,
              })
              expect(assertions).toEqual([])
              expect(checks).toEqual([])
              expect(runs).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  liveIf(process.platform !== "win32")("checks syntax after approval and before the run", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        checkResult = { ...result, exitCode: 2, output: Buffer.from("sh: -c: line 0: syntax error\n") }
        return withTool(tmp.path, (registry) => executeTool(registry, call({ command: "echo )" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(checks).toEqual([{ shell: "/bin/sh", args: ["-n", "-c", "echo )"] }])
              expect(runs).toEqual([])
              expect(settled.type).toBe("error")
              expect(settled.value).toContain("sh: -c: line 0: syntax error")
              expect(settled.value).toContain("not run")
              expect(settled.value).toContain("`stdin`")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  liveIf(process.platform !== "win32")("runs the command when the syntax check itself fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          // A shell that cannot be spawned: the check fails, so it does not block.
          configuredShell = path.join(tmp.path, "missing", "sh")
          yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(checks).toHaveLength(1)
          expect(runs).toHaveLength(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("skips the syntax check for shells without a reliable -n", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          for (const shell of ["/usr/local/bin/fish", "/usr/bin/pwsh", "powershell.exe", "cmd.exe", "/opt/x/nushell"]) {
            reset()
            configuredShell = shell
            yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command: "echo )" })))
            expect(checks).toEqual([])
            expect(runs).toHaveLength(1)
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  liveIf(process.platform !== "win32")("skips the syntax check when the command can change how later lines parse", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          for (const command of [
            "shopt -s extglob\nls !(x)",
            "alias x=y\nx",
            "unalias ll",
            "set -o posix\necho )",
            "source ./env.sh",
            ". ./env.sh",
            "true && . ~/.profile",
            'eval "$x"',
            "enable -n echo",
            "setopt kshglob",
            "unsetopt aliases",
            "emulate sh",
            "builtin cd /",
            "trap 'echo x' EXIT",
            "echo ok; exit 0\necho )",
            "exec zsh",
            "sh'opt' -s extglob",
            "\\set -e",
            "options[kshglob]=on",
            "BASH_ALIASES[x]=y",
            "POSIXLY_CORRECT=1 echo",
          ]) {
            reset()
            yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command })))
            expect({ command, checks: checks.length }).toEqual({ command, checks: 0 })
            expect(runs).toHaveLength(1)
          }
          for (const command of ["ls ./src", "echo settings", "git diff --exit-code", "cd .."]) {
            reset()
            yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command })))
            expect({ command, checks: checks.length }).toEqual({ command, checks: 1 })
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("skips the syntax check when a startup file could run first", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          for (const key of ["BASH_ENV", "ENV"]) {
            reset()
            const previous = process.env[key]
            process.env[key] = path.join(tmp.path, "env.sh")
            yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd" }))).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (previous === undefined) delete process.env[key]
                  else process.env[key] = previous
                }),
              ),
            )
            expect(checks).toEqual([])
            expect(runs).toHaveLength(1)
          }

          // zsh reads zshenv even for `-c`; with one present the check is skipped.
          reset()
          configuredShell = "/bin/zsh"
          const previous = process.env.ZDOTDIR
          process.env.ZDOTDIR = tmp.path
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".zshenv"), "setopt kshglob\n"))
          yield* withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd" }))).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previous === undefined) delete process.env.ZDOTDIR
                else process.env.ZDOTDIR = previous
              }),
            ),
          )
          expect(checks).toEqual([])
          expect(runs).toHaveLength(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

if (process.platform !== "win32") {
  // The real AppProcess, recording which runs were `-n` syntax checks.
  const realChecks: string[][] = []
  const recordingProcess = Layer.effect(
    AppProcess.Service,
    Effect.gen(function* () {
      const real = yield* AppProcess.Service
      return AppProcess.Service.of({
        ...real,
        run: (command, options) => {
          if (command._tag === "StandardCommand" && command.args[0] === "-n")
            realChecks.push([command.command, ...command.args])
          return real.run(command, options)
        },
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))

  const runReal = (directory: string, input: typeof BashTool.Input.Type, shell?: string) =>
    Effect.suspend(() => {
      reset()
      realChecks.length = 0
      configuredShell = shell
      return withTool(directory, (registry) => settleTool(registry, call(input)), recordingProcess)
    })

  const text = (settled: ToolRegistry.Settlement) =>
    settled.result.type === "content"
      ? settled.result.value.map((part: ToolContent) => (part.type === "text" ? part.text : "")).join("\n")
      : String(settled.result.value)

  const shells = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh", "/bin/mksh"].filter((shell) =>
    existsSync(shell),
  )
  // Only the system zsh without zshenv files is checked; see BashTool.
  const zshChecked = () =>
    [
      "/etc/zshenv",
      "/etc/zsh/zshenv",
      path.join(process.env.ZDOTDIR || process.env.HOME || "/nonexistent", ".zshenv"),
      path.join(process.env.ZDOTDIR || process.env.HOME || "/nonexistent", ".zshenv.zwc"),
    ].every((file) => !existsSync(file)) &&
    !process.env.BASH_ENV &&
    !process.env.ENV

  const valid = (shell: string) => {
    const name = path.basename(shell)
    const posix: Array<[string, string, string]> = [
      ["quoted heredoc", "cat <<'EOF'\nliteral $HOME $(echo no) `echo no`\nEOF", "literal $HOME $(echo no) `echo no`"],
      ["tab-stripped heredoc with expansions", "cat <<-EOF\n\tsub $(echo inner) `echo tick`\n\tEOF", "sub inner tick"],
      ["heredoc inside a command substitution", "x=$(cat <<'EOF'\nfrom heredoc\nEOF\n)\necho \"$x\"", "from heredoc"],
      ["case", 'v=b\ncase "$v" in\n  a) echo no ;;\n  b|c) echo case-ok ;;\n  *) echo no ;;\nesac', "case-ok"],
      ["function", 'greet() {\n  echo "fn-$1"\n}\ngreet ok', "fn-ok"],
      ["arithmetic", "echo $(( (2 + 3) * 4 ))", "20"],
      ["comments", "# leading comment with 'quote\necho comment-ok # trailing ) comment", "comment-ok"],
      ["line continuation", "echo cont \\\n  inued", "cont inued"],
      ["unicode", "echo '中文 ✓ émoji 🚀'", "中文 ✓ émoji 🚀"],
      ["nested quotes", `echo "it's \\"nested\\" \`echo ok\`"`, `it's "nested" ok`],
    ]
    const extended: Array<[string, string, string]> = [
      ["double brackets", "[[ abc == a* ]] && echo dbl-ok", "dbl-ok"],
      ["here-string", "cat <<< 'here string'", "here string"],
    ]
    const substitution: Array<[string, string, string]> = [["process substitution", "cat <(echo proc-sub)", "proc-sub"]]
    return [
      ...posix,
      ...(["bash", "zsh", "ksh", "mksh"].includes(name) ? extended : []),
      ...(["bash", "zsh"].includes(name) ? substitution : []),
    ]
  }

  const invalid = (shell: string) => {
    const name = path.basename(shell)
    return [
      // ksh accepts an unterminated quote at end of input, both under -n and when run.
      ...(["ksh", "mksh"].includes(name) ? [] : [["unclosed quote", "touch marker\necho 'abc"]]),
      ["heredoc left open swallows fi", "touch marker\nif true; then\ncat <<EOF\nbody\nfi"],
      ["if without fi", "touch marker\nif true; then echo a"],
      ["error on the second line", "touch marker\necho )"],
    ]
  }

  describe.each(shells)("BashTool syntax check with %s", (shell) => {
    const checked = path.basename(shell) !== "zsh" || zshChecked()

    it.live("passes and runs legal commands that are easy to misparse", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            for (const [label, command, expected] of valid(shell)) {
              const settled = yield* runReal(tmp.path, { command }, shell)
              expect({ label, text: text(settled) }).toEqual({
                label,
                text: `${expected}\n\n[exit code 0]`,
              })
              expect({ label, checks: realChecks }).toEqual({
                label,
                checks: checked ? [[shell, "-n", "-c", command]] : [],
              })
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    liveIf(checked)("refuses to run a command that does not parse and returns the shell's report", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            for (const [label, command] of invalid(shell)) {
              const settled = yield* runReal(tmp.path, { command }, shell)
              const report = Bun.spawnSync([shell, "-n", "-c", command], { cwd: tmp.path }).stderr.toString().trim()
              expect(report).not.toBe("")
              expect({ label, type: settled.result.type }).toEqual({ label, type: "error" })
              expect(text(settled)).toContain(report)
              expect(text(settled)).toContain("The command was not run")
              expect(text(settled)).toContain("`stdin`")
              expect({ label, ran: existsSync(path.join(tmp.path, "marker")) }).toEqual({ label, ran: false })
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })

  describe("BashTool real shell behavior", () => {
    liveIf(existsSync("/bin/bash"))("runs bash extglob after shopt without checking syntax", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all(["a.txt", "b.txt"].map((file) => fs.writeFile(path.join(tmp.path, file), ""))),
            )
            const command = "shopt -s extglob\nls !(b.txt)"
            // `-n` alone would reject the pattern, since it never runs the shopt.
            expect(Bun.spawnSync(["/bin/bash", "-n", "-c", command]).exitCode).not.toBe(0)
            const settled = yield* runReal(tmp.path, { command }, "/bin/bash")
            expect(text(settled)).toBe("a.txt\n\n[exit code 0]")
            expect(realChecks).toEqual([])
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("delivers stdin byte for byte", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const head = "cat <<'EOF'\n$HOME `uname` $(id) 'single' \"double\" back\\slash \\n 中文 🚀\nEOF\n"
            const stdin = head + "x".repeat(70 * 1024) + "\nend"
            // Large output is bounded for the model, so compare what the command received on disk.
            const settled = yield* runReal(tmp.path, { command: "cat > received.txt", stdin })
            expect(settled.output?.structured).toMatchObject({ exit: 0 })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "received.txt"), "utf8"))).toBe(stdin)
            const echoed = yield* runReal(tmp.path, { command: "cat", stdin: head })
            expect(echoed.output?.content[0]).toEqual({ type: "text", text: head })
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    liveIf(existsSync("/bin/bash"))("hands a script to bash -s without any quoting", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const stdin = [
              "x='a b'",
              'echo "$x" `echo tick` $((2 + 3))',
              "cat <<'EOF'",
              "$HOME stays literal",
              "EOF",
              "printf '%s\\n' \"it's done\"",
            ].join("\n")
            const settled = yield* runReal(tmp.path, { command: "bash -s", stdin })
            expect(text(settled)).toBe("a b tick 5\n$HOME stays literal\nit's done\n\n[exit code 0]")
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("closes stdin when none is given so a reader ends at once", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const started = Date.now()
            const settled = yield* runReal(tmp.path, { command: "cat", timeout: 5_000 })
            expect(settled.output?.structured).toMatchObject({ exit: 0 })
            expect(settled.output?.structured).not.toHaveProperty("timeout")
            expect(Date.now() - started).toBeLessThan(4_000)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("does not hang when the command ignores a large stdin", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const stdin = "y".repeat(BashTool.MAX_STDIN_BYTES)
            for (const command of ["true", "sleep 0.2; echo late", "head -c 3"]) {
              const started = Date.now()
              const settled = yield* runReal(tmp.path, { command, stdin, timeout: 10_000 })
              expect({ command, structured: settled.output?.structured }).toMatchObject({
                command,
                structured: { exit: 0 },
              })
              expect(Date.now() - started).toBeLessThan(5_000)
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("runs with plugin shell.env variables and the inherited PATH", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const settled = yield* Effect.suspend(() => {
              reset()
              pluginEnv = { MIAO_PLUGIN_VAR: "from-plugin" }
              return withTool(
                tmp.path,
                (registry) =>
                  settleTool(registry, call({ command: 'echo "$MIAO_PLUGIN_VAR"; test -n "$PATH" && echo path-ok' })),
                recordingProcess,
              )
            })
            expect(text(settled)).toContain("from-plugin\npath-ok")
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("still times out a command that never reads its stdin", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const settled = yield* runReal(tmp.path, {
              command: "sleep 30",
              stdin: "z".repeat(BashTool.MAX_STDIN_BYTES),
              timeout: 500,
            })
            expect(settled.output?.structured).toMatchObject({ timeout: true })
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  })
}

if (process.platform === "win32") {
  const runRealWindows = (directory: string, input: typeof BashTool.Input.Type, shell?: string) =>
    Effect.suspend(() => {
      reset()
      configuredShell = shell
      return withTool(
        directory,
        (registry) => settleTool(registry, call(input)),
        LayerNode.compile(AppProcess.node),
      )
    })

  const windowsText = (settled: ToolRegistry.Settlement) =>
    settled.result.type === "content"
      ? settled.result.value.map((part: ToolContent) => (part.type === "text" ? part.text : "")).join("\n")
      : String(settled.result.value)

  // Windows ships Windows PowerShell; PS7 may sit alongside it. Honor an
  // override for hosts that keep a portable build outside PATH.
  const powerShell = [
    process.env.MIAO_TEST_PWSH,
    process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : undefined,
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  ].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate))

  it.live("runs the default Windows shell through /d /s /c and reports its native exit code", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const invoked = yield* runRealWindows(tmp.path, { command: "echo %CMDCMDLINE%" })
          expect(windowsText(invoked)).toContain("/d /s /c")

          const failed = yield* runRealWindows(tmp.path, { command: "exit /b 3" })
          expect(windowsText(failed)).toContain("[exit code 3]")
          expect(failed.output?.structured).toMatchObject({ exit: 3 })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (powerShell) {
    it.live("invokes a configured PowerShell profile-free with -Command", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const settled = yield* runRealWindows(tmp.path, { command: "[Environment]::CommandLine" }, powerShell)
            const line = windowsText(settled)
            expect(line).toContain("-NoProfile")
            expect(line).toContain("-Command")
            expect(line).not.toContain("/d /s /c")
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("preserves PowerShell quoting, metacharacters, and non-ASCII output", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const settled = yield* runRealWindows(
              tmp.path,
              { command: "Write-Output 'a & b | c > d'; Write-Output '中文'" },
              powerShell,
            )
            const output = windowsText(settled)
            expect(output).toContain("a & b | c > d")
            expect(output).toContain("中文")
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }
}

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port PowerShell parser-based approval reduction (bash commands already split per command with BashArity prefixes).",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
