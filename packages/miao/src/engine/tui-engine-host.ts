import { Cause, Context, Deferred, Effect, Logger, Option, References } from "effect"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { Credential } from "@miao/core/credential"
import { Database } from "@miao/core/database/database"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Global } from "@miao/core/global"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { McpAuth } from "@miao/core/mcp/auth"
import { Logging } from "@miao/core/observability/logging"
import { PluginV2 } from "@miao/core/plugin"
import { SkillV2 } from "@miao/core/skill"
import { ProjectV2 } from "@miao/core/project"
import { RuntimeIdentity } from "@miao/core/runtime/identity"
import { WorkspaceV2 } from "@miao/core/workspace"
import { AbsolutePath } from "@miao/core/schema"
import { AmbientContext } from "./ambient-context"
import { engineArgs, type EngineOptions } from "./client"
import { discoveredEngine, resolveEngine } from "./discovery"
import { prepareMcpConfig } from "./mcp-config"
import { compactionSettings, engineSettings, nativeEngineOptions } from "./native-engine"
import { ProductFormatter } from "./product-formatter"
import { ProductHooks } from "./product-hooks"
import { ProductMcp } from "./product-mcp"
import { ProductPermission } from "./product-permission"
import { ProductRoutes } from "./product-routes"
import { ProductTuiAgent } from "./product-tui-agent"

/**
 * The Rust TUI starts `miao-engine` itself, but it can only forward the
 * operator's environment as a fixed table of flags. That table carries no
 * product route or credential source, which is why a machine whose credentials
 * live in the product database kept dying at startup with "API key or explicit
 * credential source is required".
 *
 * This module stands where the engine would stand. The launcher points
 * `MIAO_ENGINE_BIN` at a shim script, the shim prepares the same engine plan the
 * TypeScript host would prepare for this Location, and then it runs the real
 * engine and relays frames between the TUI and that child. Temporary manifests
 * and the local AI-SDK gateway live in a scope held for the engine's lifetime.
 */

export interface TuiEnginePlan {
  readonly argv: string[]
  readonly env: Record<string, string | undefined>
  /** Releases the MCP manifest when the engine that read it has exited. */
  readonly dispose?: () => void
  /**
   * Host authority the engine does not own. The shim answers a TUI
   * `host_call` frame here instead of forwarding it, so workspace creation and
   * remote-control pairing stay with the product services that own them.
   */
  readonly hostCall?: (op: string, params: unknown) => Promise<unknown>
}

/** The argv the Rust TUI passes the engine: only these carry a Location. */
export function parseTuiEngineArgs(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!argument.startsWith("--")) continue
    const split = argument.indexOf("=")
    if (split !== -1) {
      values.set(argument.slice(0, split), argument.slice(split + 1))
      continue
    }
    const next = args[index + 1]
    if (next === undefined || next.startsWith("--")) continue
    values.set(argument, next)
    index++
  }
  return { database: values.get("--db"), workspace: values.get("--workspace"), model: values.get("--model") }
}

const locationOf = (workspace: string) => Location.Ref.make({ directory: AbsolutePath.make(workspace) })

/**
 * The engine plan for one Location. Mirrors the per-Location preparation in
 * `native-engine.ts`: product routes and credentials, MCP, configuration
 * sources, ambient context, hooks, LSP and formatter manifests. Product tools,
 * plugin hooks and saved permission rules need a live RPC bridge and stay out
 * of this manifest.
 */
const preparePlan = Effect.fn("Engine.tuiEnginePlan")(function* (
  input: { workspace: string; database: string; model?: string },
  binary: string,
) {
  const ref = locationOf(input.workspace)
  const global = yield* Global.Service
  const plugins = yield* PluginV2.Service
  yield* Deferred.await(plugins.booted)
  const settings = yield* Effect.promise(() => engineSettings(global.config))
  const compaction = yield* Effect.promise(() => compactionSettings(global.config))
  // `MIAO_ENGINE_BIN` names this shim in the engine's environment; the real
  // binary arrives separately and is the only one discovery may use.
  const configuration = nativeEngineOptions({ ...process.env, MIAO_ENGINE_BIN: binary }, settings)
  if (!configuration) return yield* Effect.die("no engine binary is configured")
  configuration.configDir = global.config
  configuration.env = { MIAO_TOOL_BIN: global.bin }
  // The TUI's placeholder means "no choice was made"; otherwise the operator
  // picked a model, and the route manifest has to be built for that model or
  // the engine refuses the default route at startup.
  if (input.model && input.model !== "unavailable/model") configuration.model = input.model
  // S5: the engine derives policy and LSP from the same ordered source plan the
  // Config service applied, so project configuration reaches it.
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  const configSources = config?.sources ? JSON.stringify(yield* config.sources()) : undefined
  const routes = yield* ProductRoutes.prepare(ref, configuration, compaction)
  const mcp = yield* ProductMcp.prepare(configuration)
  const effective = { ...configuration, ...routes, ...mcp, ...(configSources ? { configSources } : {}) }
  const context = yield* AmbientContext.prepare(ref, effective)
  const hooks = yield* ProductHooks.prepare(ref, { ...effective, ...context.options })
  const formatter = yield* ProductFormatter.prepare(ref, effective)
  // Resolve the Agent before a permission handoff can freeze legacy ownership.
  const agent = yield* ProductTuiAgent.prepare(effective)
  const database = yield* Database.Service
  // The TUI shows which integrations have a stored credential, never the values.
  const credentials = yield* Credential.Service
  // Skills are optional: a graph without the skill service exports none rather
  // than failing the TUI start.
  const skillService = Option.getOrUndefined(yield* Effect.serviceOption(SkillV2.Service))
  // Workspaces need the project the directory resolves to, plus the workspace
  // service; either one missing exports no workspaces.
  const projectService = Option.getOrUndefined(yield* Effect.serviceOption(ProjectV2.Service))
  const workspaceService = Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceV2.Service))
  const resolved = projectService
    ? yield* projectService.resolve(AbsolutePath.make(input.workspace))
    : undefined
  const workspaces =
    resolved && workspaceService
      ? (yield* workspaceService.list({
          projectID: resolved.id,
          directory: resolved.directory,
        })).map((workspace) => ({
          name: workspace.name,
          detail: workspace.branch ?? workspace.type,
          // A move needs a destination path; the engine performs the transfer,
          // the TUI only names where.
          directory: workspace.directory ?? "",
        }))
      : []
  // Remote-control devices come from the host's administration; a graph
  // without it exports none rather than failing the TUI start.
  const identityService = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeIdentity.Service))
  // `administration` may answer synchronously or with a promise; resolve both
  // shapes before reading the device grants.
  const administration = identityService?.administration
    ? yield* Effect.promise(() => Promise.resolve(identityService.administration!()))
    : undefined
  // Rows carry the identity an approve or revoke must echo. The annotation is
  // explicit so the grant and pending halves share one row type instead of a
  // union TypeScript cannot read fields from.
  type DeviceRow = {
    name: string
    detail: string
    id: string
    version: number
    pairingKey: string
    kind: "grant" | "pending"
  }
  const devices: DeviceRow[] = [
    ...(administration?.devices() ?? [])
      .filter((grant) => grant.revokedAt === null)
      .map((grant): DeviceRow => ({
        name: grant.label,
        detail: `${grant.publicKey.slice(0, 16)} · ${new Date(grant.createdAt * 1000)
          .toISOString()
          .slice(0, 10)}`,
        id: grant.id,
        version: grant.version,
        pairingKey: grant.publicKey,
        kind: "grant",
      })),
    ...(administration?.pending() ?? []).map((candidate): DeviceRow => ({
      name: `${candidate.candidate.label} (pending)`,
      detail: `${candidate.candidate.publicKey.slice(0, 16)} · awaiting approval`,
      id: candidate.pairingID,
      version: 0,
      pairingKey: candidate.candidate.publicKey,
      kind: "pending",
    })),
  ]
  const skills = skillService
    ? (yield* skillService.list()).map((skill) => ({
        name: skill.name,
        detail: skill.description ?? "",
      }))
    : []
  const providers = (yield* credentials.all())
    .filter((credential) => credential.active)
    .map((credential) => ({
      name: String(credential.integrationID),
      detail: credential.label,
    }))
  const permission = yield* ProductPermission.prepare(ref, {
    binary,
    source: input.database,
    database,
    enabled: process.env.MIAO_SHARED_PERMISSIONS === "1",
    savedRules: configuration.savedRules,
  })
  const options: EngineOptions = {
    ...effective,
    ...context.options,
    ...hooks,
    ...formatter,
    ...permission.options,
    ...agent,
    db: input.database,
    workspace: input.workspace,
    // The route manifest names the model it was built for; serve that model so
    // the engine's default route and the manifest cannot disagree.
    model: effective.model,
  }
  const manifest = prepareMcpConfig(options)
  // Read-only TUI panels render what the host already resolved. MCP servers
  // are the first: names and transports only, never headers or environment.
  const mcpServers = Object.entries(configuration.mcpSettings?.servers ?? {})
    .filter(([, server]) => !server.disabled)
    .map(([name, server]) =>
      server.type === "local"
        ? { name, detail: server.command.join(" ") }
        : { name, detail: server.url },
    )
  // Ops the TUI may ask the host to perform. Each one runs in this Effect's
  // service graph, which is the only place that owns the product state.
  // Remote-control authority lives with the host's runtime identity, the same
  // place the device panel reads from.
  const resolveAdministration = async () => {
    const value = await Promise.resolve(identityService?.administration?.())
    if (!value) throw new Error("remote control is unavailable in this host")
    return value
  }
  const hostCall = async (op: string, params: unknown) => {
    const input = (params ?? {}) as Record<string, unknown>
    if (op === "remote.pending") return (await resolveAdministration()).pending()
    if (op === "remote.approve") {
      return (await resolveAdministration()).approve(String(input.pairingID), String(input.publicKey))
    }
    if (op === "remote.reject") {
      ;(await resolveAdministration()).reject(String(input.pairingID))
      return { ok: true }
    }
    if (op === "remote.revoke") {
      await (await resolveAdministration()).revoke(String(input.grantID), Number(input.version))
      return { ok: true }
    }
    if (op !== "workspace.create") throw new Error(`unknown host call: ${op}`)
    if (!projectService || !workspaceService) {
      throw new Error("workspace creation is unavailable in this host")
    }
    const request = params as { directory?: string } | undefined
    if (!request?.directory) throw new Error("workspace.create needs a directory")
    const resolved = await Effect.runPromise(projectService.resolve(AbsolutePath.make(request.directory)))
    return await Effect.runPromise(
      workspaceService.create(params as never, {
        projectID: resolved.id,
        directory: resolved.directory,
      }),
    )
  }
  return {
    hostCall,
    // The shim inherits the operator's environment and stands in for the TUI's
    // direct child, so provider environment keys keep reaching the engine.
    env: {
      ...process.env,
      ...manifest?.environment,
      ...options.env,
      MIAO_TUI_MCP_JSON: JSON.stringify(mcpServers),
      MIAO_TUI_PROVIDERS_JSON: JSON.stringify(providers),
      MIAO_TUI_SKILLS_JSON: JSON.stringify(skills),
      MIAO_TUI_WORKSPACES_JSON: JSON.stringify(workspaces),
      // The engine serves the same list over the `workspaces` command so the
      // TUI can read it through the engine instead of the environment.
      MIAO_DEVICES_JSON: JSON.stringify(devices),
      MIAO_WORKSPACES_JSON: JSON.stringify(workspaces),
      // The engine performs a Session move through the existing export-move;
      // the host names the product database it must detach from.
      MIAO_PRODUCT_DATABASE: Database.path(),
    },
    argv: [options.binary, ...engineArgs({ ...options, mcpConfigFile: manifest?.file ?? options.mcpConfigFile })],
    dispose: manifest?.dispose,
  } satisfies TuiEnginePlan
})

const diagnostics = Context.make(Logger.CurrentLoggers, new Set([Logging.stderrLogger])).pipe(
  Context.add(References.MinimumLogLevel, Logging.minimumLogLevel()),
)

/**
 * Prepares a plan and keeps its scope open until `close`. The scope owns the
 * temporary manifests and the local AI-SDK gateway the routes point at, so it
 * must outlive the engine child.
 */
async function startPlan(
  input: { workspace: string; database: string; model?: string },
  binary: string,
): Promise<{ plan: TuiEnginePlan; close: () => Promise<void> }> {
  const ready = Promise.withResolvers<TuiEnginePlan>()
  const stop = Promise.withResolvers<void>()
  const done = Promise.withResolvers<void>()
  const ref = locationOf(input.workspace)
  Effect.runFork(
    preparePlan(input, binary).pipe(
      Effect.tap((plan) =>
        Effect.sync(() => {
          ready.resolve(plan)
        }),
      ),
      Effect.flatMap(() => Effect.promise(() => stop.promise)),
      Effect.scoped,
      Effect.provide(LayerNode.compile(LayerNode.group([Global.node, Credential.node, McpAuth.node, Database.node]))),
      Effect.provide(LocationServiceMap.Service.get(ref)),
      Effect.provide(locationServiceMapLayer),
      Effect.onExit(() =>
        Effect.sync(() => {
          done.resolve()
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          ready.reject(new Error(Cause.pretty(cause)))
        }),
      ),
      Effect.provide(diagnostics),
    ),
  )
  return {
    plan: await ready.promise,
    close: async () => {
      stop.resolve()
      await done.promise
    },
  }
}

/**
 * Relays frames between this process's stdio and the engine child. Output goes
 * through a {@link Bun.FileSink}: a reply can be megabytes (a Session snapshot
 * inlines its image attachments), and a single `Bun.write` to a pipe stops at
 * the reader's buffer, which would leave the TUI waiting on a frame that never
 * ends.
 */
async function runEngine(
  argv: string[],
  env: Record<string, string | undefined>,
  hostCall?: (op: string, params: unknown) => Promise<unknown>,
): Promise<number> {
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit", env })
  // The TUI speaks NDJSON. With a host handler, frames are read line by line so
  // a `host_call` can be answered here; without one every byte is forwarded.
  void (async () => {
    const input = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    const send = async (frame: unknown) => {
      child.stdin.write(JSON.stringify(frame) + "\n")
      await child.stdin.flush()
    }
    try {
      for (;;) {
        const { done, value } = await input.read()
        if (done) break
        if (!hostCall) {
          child.stdin.write(value)
          await child.stdin.flush()
          continue
        }
        buffered += decoder.decode(value, { stream: true })
        let newline = buffered.indexOf("\n")
        while (newline !== -1) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          let frame: { id?: unknown; method?: unknown; params?: unknown } | undefined
          try {
            frame = JSON.parse(line)
          } catch {
            frame = undefined
          }
          if (frame?.method === "host_call") {
            try {
              await send({ id: frame.id, result: await hostCall(String((frame.params as { op?: unknown })?.op), (frame.params as { params?: unknown })?.params) })
            } catch (error) {
              await send({ id: frame.id, error: error instanceof Error ? error.message : String(error) })
            }
          } else {
            child.stdin.write(line + "\n")
            await child.stdin.flush()
          }
          newline = buffered.indexOf("\n")
        }
      }
      if (buffered.length > 0) {
        child.stdin.write(buffered)
        await child.stdin.flush()
      }
    } catch {}
    try {
      await child.stdin.end()
    } catch {}
  })()
  // Drain the engine's output while it runs: waiting for exit first could
  // deadlock once a reply fills the pipe buffer.
  const output = (async () => {
    const replies = child.stdout.getReader()
    const sink = Bun.stdout.writer()
    try {
      for (;;) {
        const { done, value } = await replies.read()
        if (done) break
        sink.write(value)
        await sink.flush()
      }
    } catch {}
  })()
  const forward = () => child.kill()
  process.once("SIGTERM", forward)
  process.once("SIGINT", forward)
  const code = await child.exited
  process.off("SIGTERM", forward)
  process.off("SIGINT", forward)
  await output
  return code
}

/**
 * Runs the engine the Rust TUI asked for, through the product's engine plan.
 * Preparation failures terminate startup, including partially completed permission
 * handoffs; raw engine arguments cannot recover that ownership safely.
 */
export async function runEngineShim(args: string[]): Promise<number> {
  const parsed = parseTuiEngineArgs(args)
  const binary = process.env.MIAO_ENGINE_REAL_BIN ?? discoveredEngine()
  if (binary) {
    try {
      resolveEngine({ environment: { MIAO_ENGINE_BIN: binary } })
    } catch (error) {
      process.stderr.write(`miao engine-shim: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (!binary || !parsed.workspace || !parsed.database) {
    if (!binary) {
      process.stderr.write("miao engine-shim: could not find miao-engine\n")
      return 1
    }
    return runEngine([binary, ...args], { ...process.env })
  }
  const started = await startPlan(
    { workspace: parsed.workspace, database: parsed.database, model: parsed.model },
    binary,
  ).catch((error: unknown) => {
    process.stderr.write(
      `miao engine-shim: could not prepare the product engine plan: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return undefined
  })
  if (!started) return 1
  try {
    return await runEngine(started.plan.argv, started.plan.env, started.plan.hostCall)
  } finally {
    started.plan.dispose?.()
    await started.close()
  }
}

/**
 * Writes the shim script the Rust TUI starts in place of the engine. The TUI
 * appends its engine argv, so the script inserts the hidden shim command and
 * forwards everything else. Windows passes the executable and literal argument
 * prefix directly to the Rust launcher without a shell wrapper.
 */
export async function rustEngineShim(environment: Record<string, string | undefined> = process.env) {
  const engine = environment.MIAO_ENGINE_BIN ?? discoveredEngine()
  if (!engine) return undefined
  const self =
    typeof MIAO_PACKAGED !== "undefined" && MIAO_PACKAGED
      ? [process.execPath]
      : [process.execPath, ...process.execArgv, process.argv[1]]
  if (process.platform === "win32")
    return {
      program: self[0]!,
      args: [...self.slice(1), "__engine-shim"],
      engine,
      dispose: async () => {},
    }
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-engine-shim-"))
  const program = path.join(directory, "miao-engine")
  await Bun.write(program, `#!/bin/sh\nexec ${self.map(quote).join(" ")} __engine-shim "$@"\n`)
  await chmod(program, 0o700)
  return {
    program,
    args: [],
    engine,
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

const quote = (argument: string) => `'${argument.replaceAll("'", `'\\''`)}'`
