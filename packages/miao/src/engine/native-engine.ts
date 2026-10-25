import type { NativeCommand, NativeAgentReferences } from "./command-manifest"
import type { AgentAttachment } from "@miao/schema/prompt"
import { Event } from "@miao/schema/event"
import { SessionEvent } from "@miao/schema/session-event"
import { agentManifest, modelRoute, type Route } from "./product-agent"
import { LocationServiceMap } from "@miao/core/location-service-map"
import type { LocationServices } from "@miao/core/location-services"
import { SessionCreate } from "@miao/core/session-create"
import { SessionModelRoute } from "@miao/schema/session-model-route"
import { Model } from "@miao/schema/model"
import { AmbientContext } from "./ambient-context"
import { ProductHooks } from "./product-hooks"
import { PluginHooks } from "./plugin-hooks"
import { ProductLsp } from "./product-lsp"
import { ProductFormatter } from "./product-formatter"
import { ProductPolicy } from "./product-policy"
import { ProductRoutes } from "./product-routes"
import { ProductMcp } from "./product-mcp"
import { McpAuth } from "@miao/core/mcp/auth"
import { PromptMaterialization } from "./prompt-materialization"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Credential } from "@miao/core/credential"
import { Integration } from "@miao/core/integration"
import { GoogleAccount } from "@miao/core/google-account"
import { CredentialDaemon } from "@miao/core/credential/daemon"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { SandboxPolicy } from "@miao/core/sandbox/policy"
import { AbsolutePath } from "@miao/core/schema"
import { ResponsesCacheContract, ResponsesWebSocketContract } from "@miao/schema/config"
import { Global } from "@miao/core/global"
import { makeGlobalNode } from "@miao/core/effect/app-node"
import { ClientEvents } from "@miao/server/client-events"
import { NativeEngine } from "@miao/server/native-engine"
import { generateNativeTitle } from "@miao/server/native-session"
import { ConflictError } from "@miao/protocol/errors"
import type { OpenCodeEvent } from "@miao/protocol/groups/event"
import { Location } from "@miao/schema/location"
import { Cause, DateTime, Effect, Layer, Option, Queue, Schema, Context } from "effect"
import { EngineError, type EngineOptions, type EngineEvent } from "./client"
import { discoveredEngine } from "./discovery"
import { makeEngineOwners } from "./owners"
import type { EnginePricing } from "./session"
import { NativeRecovery } from "./recovery"
import { ProductTools } from "./product-tools"
import { engineMessageSequence } from "./message-sequence"
import { Permission } from "@miao/schema/permission"
import { Database } from "@miao/core/database/database"
import { EventV2 } from "@miao/core/event"
import { AgentV2 } from "@miao/core/agent"
import { LLMClient } from "@miao/llm"
import { llmClient } from "@miao/core/effect/app-node-platform"
import { SessionNativeTitle } from "@miao/core/session/native-title"
import { SessionTitle } from "@miao/core/session/title"
import { SessionRunnerModel } from "@miao/core/session/runner/model"
import { memoMap } from "@miao/core/effect/memo-map"

import { SessionStore } from "@miao/core/session/store"
import { SessionOwnership } from "@miao/core/session/ownership"
import { SessionUsageStore } from "@miao/core/session/usage-store"
import { Question } from "@miao/schema/question"
import { translateApproval, translateQuestion } from "./bridge"

const ApprovalBindings = Schema.Struct({
  approvals: Schema.Array(
    Schema.Struct({
      request_id: Schema.String,
      session_id: Schema.String,
      input_hash: Schema.String,
      policy_revision: Schema.String,
      tool: Schema.String,
      resource: Schema.String,
    }),
  ),
})
const QuestionBindings = Schema.Array(
  Schema.Struct({
    question_id: Schema.String,
    input_hash: Schema.String,
    input: Schema.Unknown,
  }),
)
/** The engine's `{accepted: boolean}` reply shared by cancel-shaped commands. */
const AcceptedReply = Schema.Struct({ accepted: Schema.Boolean })

import { replayJournal } from "./journal"
import { readTranscript } from "./transcript"

/**
 * Production native transport, opt-in through the engine binary environment:
 * without `MIAO_ENGINE_BIN` the layer is never built and native-owned Sessions
 * keep the explicit refusal. The model identity is required from the operator
 * because the engine cannot invent provider credentials or catalog facts.
 */
export const nativeEngineOptions = (
  environment: Record<string, string | undefined> = process.env,
  settings: Omit<EngineOptions, "db" | "workspace"> | undefined = undefined,
): Omit<EngineOptions, "db" | "workspace"> | undefined => {
  // An explicit binary wins; otherwise use a discovered, protocol-compatible
  // installation so native Sessions need no environment variable. A custom
  // environment object stays deterministic for tests.
  const binary = environment.MIAO_ENGINE_BIN ?? (environment === process.env ? discoveredEngine() : undefined)
  if (!binary) return undefined
  const limits = environment.MIAO_CONTEXT_LIMITS
  // Precedence: the operator's environment overrides the global config file
  // key by key; an absent key falls through to the configured value.
  const merged: Omit<EngineOptions, "db" | "workspace"> = {
    ...settings,
    binary,
    model: environment.MIAO_ENGINE_MODEL ?? settings?.model ?? "",
  }
  if (environment.MIAO_ENGINE_PROVIDER) merged.provider = environment.MIAO_ENGINE_PROVIDER
  if (environment.MIAO_ENGINE_ENDPOINT) merged.endpoint = environment.MIAO_ENGINE_ENDPOINT
  if (environment.MIAO_ENGINE_MODEL_ROUTES)
    merged.modelRoutesConfigFile = path.resolve(environment.MIAO_ENGINE_MODEL_ROUTES)
  if (environment.MIAO_ENGINE_FORMATTER_CONFIG)
    merged.formatterConfigFile = path.resolve(environment.MIAO_ENGINE_FORMATTER_CONFIG)
  if (environment.MIAO_ENGINE_FALLBACK_MODEL) merged.fallbackModel = environment.MIAO_ENGINE_FALLBACK_MODEL
  if (environment.MIAO_ENGINE_TOOL_DISCLOSURE) {
    if (!["full", "compact"].includes(environment.MIAO_ENGINE_TOOL_DISCLOSURE))
      throw new Error("MIAO_ENGINE_TOOL_DISCLOSURE must be full or compact")
    merged.toolDisclosure = environment.MIAO_ENGINE_TOOL_DISCLOSURE === "compact" ? "compact" : "full"
  }
  if (environment.MIAO_ENGINE_ROLES) merged.roles = JSON.parse(environment.MIAO_ENGINE_ROLES)
  if (environment.MIAO_ENGINE_RESPONSES_CACHE_CONTRACT)
    merged.responsesCacheContract = Schema.decodeUnknownSync(Schema.fromJsonString(ResponsesCacheContract), {
      onExcessProperty: "error",
    })(environment.MIAO_ENGINE_RESPONSES_CACHE_CONTRACT)
  if (environment.MIAO_ENGINE_RESPONSES_WEBSOCKET_CONTRACT)
    merged.responsesWebSocketContract = Schema.decodeUnknownSync(Schema.fromJsonString(ResponsesWebSocketContract), {
      onExcessProperty: "error",
    })(environment.MIAO_ENGINE_RESPONSES_WEBSOCKET_CONTRACT)
  merged.promptCache = environment.MIAO_ENGINE_PROMPT_CACHE
    ? environment.MIAO_ENGINE_PROMPT_CACHE === "on"
    : merged.promptCache
  merged.verifyCommand = environment.MIAO_ENGINE_VERIFY_COMMAND ?? merged.verifyCommand
  merged.mcpConfigFile = environment.MIAO_ENGINE_MCP_CONFIG
    ? path.resolve(environment.MIAO_ENGINE_MCP_CONFIG)
    : merged.mcpConfigFile
  merged.lspConfigFile = environment.MIAO_ENGINE_LSP_CONFIG
    ? path.resolve(environment.MIAO_ENGINE_LSP_CONFIG)
    : merged.lspConfigFile
  merged.contextLimits = limits ? JSON.parse(limits) : merged.contextLimits
  return {
    binary: merged.binary,
    model: merged.model,
    provider: merged.provider,
    endpoint: merged.endpoint,
    // A writable workspace is an explicit operator policy, never a blanket
    // change to the engine's read-only default or permission decisions.
    policyFile: environment.MIAO_ENGINE_POLICY,
    // ADR-09: the product's credential database is the explicit channel; the
    // engine only reads it. Named provider keys are the single-key fallback.
    credentialDatabase: environment.MIAO_ENGINE_CREDENTIAL_DB,
    credentialID: environment.MIAO_ENGINE_CREDENTIAL_ID,
    credentialIntegration: environment.MIAO_ENGINE_CREDENTIAL_INTEGRATION,
    fallbackModel: merged.fallbackModel,
    toolDisclosure: merged.toolDisclosure,
    roles: merged.roles,
    responsesCacheContract: merged.responsesCacheContract,
    responsesWebSocketContract: merged.responsesWebSocketContract,
    promptCache: merged.promptCache,
    verifyCommand: merged.verifyCommand,
    mcpConfigFile: merged.mcpConfigFile,
    mcpSettings: merged.mcpSettings,
    lspConfigFile: merged.lspConfigFile,
    formatterConfigFile: merged.formatterConfigFile,
    contextConfigFile: environment.MIAO_ENGINE_CONTEXT_CONFIG ?? merged.contextConfigFile,
    skillsConfigFile: environment.MIAO_ENGINE_SKILLS_CONFIG ?? merged.skillsConfigFile,
    referencesConfigFile: environment.MIAO_ENGINE_REFERENCES_CONFIG ?? merged.referencesConfigFile,
    hooksConfigFile: environment.MIAO_ENGINE_HOOKS_CONFIG ?? merged.hooksConfigFile,
    workspaceInstructions: merged.workspaceInstructions,
    modelRoutesConfigFile: environment.MIAO_ENGINE_MODEL_ROUTES_CONFIG ?? merged.modelRoutesConfigFile,
    contextLimits: merged.contextLimits,
  }
}

/**
 * The global config document's `engine` section (B1): the engine is one
 * process serving every Location, so project documents do not configure it.
 * Files later in {@link fileNames} win, matching the Config service merge.
 */
export type EngineSettings = Omit<EngineOptions, "db" | "workspace"> & {
  /** Root of the product-side native databases; presence opts new Sessions in. */
  storage?: string
}

export const engineSettings = async (globalConfig: string): Promise<EngineSettings | undefined> => {
  let settings: EngineSettings | undefined = undefined
  const documents: Config.Entry[] = []
  for (const name of Config.fileNames) {
    const file = path.join(globalConfig, name)
    if (!(await Bun.file(file).exists())) continue
    const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file).text())))
    if (info) documents.push(new Config.Document({ type: "document", info }))
    const engine = info?.engine
    if (!engine) continue
    settings = {
      binary: "",
      model: engine.model ?? "",
      provider: engine.provider,
      endpoint: engine.endpoint,
      fallbackModel: engine.fallback_model,
      toolDisclosure: engine.tool_disclosure,
      roles: engine.roles,
      responsesCacheContract: engine.responses_cache_contract,
      responsesWebSocketContract: engine.responses_websocket_contract,
      promptCache: engine.prompt_cache,
      verifyCommand: engine.verify_command,
      mcpConfigFile: engine.mcp_config ? path.resolve(globalConfig, engine.mcp_config) : undefined,
      lspConfigFile: engine.lsp_config ? path.resolve(globalConfig, engine.lsp_config) : undefined,
      storage: engine.storage ? path.resolve(globalConfig, engine.storage) : undefined,
      contextLimits: engine.context_limits,
    }
  }
  const mcpSettings = Option.getOrUndefined(Config.decodeDocument(Config.merge(documents)))?.mcp
  return mcpSettings ? { ...(settings ?? { binary: "", model: "" }), mcpSettings } : settings
}

/**
 * The merged `compaction` section. A native Session takes its automatic context
 * management from it, so `compaction.auto`/`threshold`/`buffer` have the same
 * meaning on either engine instead of the native path silently staying off.
 */
export const compactionSettings = async (
  globalConfig: string,
): Promise<{ auto?: boolean; threshold?: number; buffer?: number } | undefined> => {
  const documents: Config.Entry[] = []
  for (const name of Config.fileNames) {
    const file = path.join(globalConfig, name)
    if (!(await Bun.file(file).exists())) continue
    const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file).text())))
    if (info) documents.push(new Config.Document({ type: "document", info }))
  }
  return Option.getOrUndefined(Config.decodeDocument(Config.merge(documents)))?.compaction
}

/**
 * The operator's sandbox switch for native engine commands: `MIAO_SANDBOX`
 * wins, then the merged `sandbox.mode`. With neither set the engine keeps its
 * historical always-sandboxed behavior.
 */
export const sandboxSettings = async (globalConfig: string): Promise<boolean> => {
  const documents: Config.Entry[] = []
  for (const name of Config.fileNames) {
    const file = path.join(globalConfig, name)
    if (!(await Bun.file(file).exists())) continue
    const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file).text())))
    if (info) documents.push(new Config.Document({ type: "document", info }))
  }
  const merged = Option.getOrUndefined(Config.decodeDocument(Config.merge(documents)))
  return SandboxPolicy.nativeEnabled(merged?.sandbox ? [merged.sandbox] : [], process.env)
}

/**
 * Root of the product-side native databases. An explicit environment variable
 * wins over the global `engine.storage` key, mirroring every other engine
 * setting; an absent root keeps new Sessions TypeScript-owned.
 */
export const engineStorageRoot = (
  environment: Record<string, string | undefined> = process.env,
  settings?: { storage?: string },
): string | undefined => {
  // An explicit empty value is the `--engine ts` opt-out: it must beat a
  // configured `engine.storage` rather than resolving to the working directory.
  const root =
    environment.MIAO_ENGINE_STORAGE !== undefined ? environment.MIAO_ENGINE_STORAGE || undefined : settings?.storage
  return root ? path.resolve(root) : undefined
}

/**
 * Switch-plan step 3's explicit opt-in: `--engine native` turns native
 * placement on for this invocation even when `engine.storage` was never
 * configured, defaulting the store beside the product database. A `ts` value
 * clears the override so a configured `engine.storage` can be opted out of on
 * a single command.
 */
export const applyEngineOptIn = (
  engine: string | undefined,
  dataDir: string,
  environment: Record<string, string | undefined> = process.env,
): void => {
  if (engine === "native" && environment.MIAO_ENGINE_STORAGE === undefined) {
    environment.MIAO_ENGINE_STORAGE = path.join(dataDir, "engines")
    return
  }
  if (engine === "ts") environment.MIAO_ENGINE_STORAGE = ""
}

/** Whether the composition root should build the native transport at all. */
export const configured = (): boolean => nativeEngineOptions() !== undefined

const refusal = (sessionID: string, error: unknown) =>
  error instanceof ConflictError
    ? error
    : new ConflictError({
        message:
          error instanceof EngineError
            ? `Native engine rejected operation for ${sessionID}: ${error.message}`
            : `Native engine operation for ${sessionID} failed unexpectedly.`,
        resource: sessionID,
      })

type Owners = Effect.Success<ReturnType<typeof makeEngineOwners>>

/** An idle native Session whose product title may still need generating. */
type NativeTitleRequest = {
  sessionID: Parameters<NativeEngine.Interface["title"]>[0]["sessionID"]
  storage: Parameters<NativeEngine.Interface["title"]>[0]["storage"]
  location: Parameters<NativeEngine.Interface["title"]>[0]["location"]
}

/** The engine store a client event came from, when the event is native's. */
const engineStorageID = (event: OpenCodeEvent) => {
  const metadata = event.metadata
  if (metadata === undefined) return undefined
  const engine = metadata.engine
  if (typeof engine !== "object" || engine === null) return undefined
  const id = (engine as { id?: unknown }).id
  if (typeof id !== "string") return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(AbsolutePath)(id))
}

/**
 * The transport implementation over a server-scoped owner registry. Kept apart
 * from the layer so tests exercise the exact code the server runs.
 */
export const fromOwners = (
  owners: Owners,
  preparation: {
    prompt?: (input: Parameters<NativeEngine.Interface["admit"]>[0]) => Effect.Effect<PromptInput.Prompt, unknown>
    command?: (
      input: Parameters<NativeEngine.Interface["command"]>[0],
      catalog: readonly Route[],
      sessionAgent: string | undefined,
    ) => Effect.Effect<{ text: string; command: NativeCommand; agentReferences: NativeAgentReferences }, unknown>
    agents?: (
      input: Parameters<NativeEngine.Interface["admit"]>[0],
      mentions: readonly AgentAttachment[],
      catalog: readonly Route[],
    ) => Effect.Effect<NativeAgentReferences, unknown>
    title?: (input: {
      sessionID: Parameters<NativeEngine.Interface["title"]>[0]["sessionID"]
      storage: Parameters<NativeEngine.Interface["title"]>[0]["storage"]
      location: Parameters<NativeEngine.Interface["title"]>[0]["location"]
      prompt: string
    }) => Effect.Effect<string | undefined, unknown>
  } = {},
  storageRoot?: string,
  pricing?: EnginePricing,
): NativeEngine.Interface => {
  const connect = (input: { storage: string; location: Location.Ref; refreshContext?: boolean }) =>
    owners.get({
      storage: input.storage,
      engineID: input.storage,
      location: input.location,
      refreshContext: input.refreshContext,
    })
  const read = <T>(
    input: { storage: string; location: Location.Ref; sessionID?: string },
    request: (connection: Effect.Success<ReturnType<Owners["get"]>>) => Promise<unknown>,
  ) =>
    connect(input).pipe(
      Effect.flatMap((connection) =>
        Effect.tryPromise({
          try: () => request(connection) as Promise<T>,
          catch: (error) => refusal(input.sessionID ?? input.storage, error),
        }),
      ),
      Effect.mapError((error) => refusal(input.sessionID ?? input.storage, error)),
    )
  const routes = async (connection: Effect.Success<ReturnType<Owners["get"]>>) =>
    Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          route_id: Schema.NullOr(Schema.String),
          model_key: Schema.optionalKey(Schema.String),
          credential_id: Schema.optionalKey(Credential.ID),
          protocol: Schema.String,
          model: Schema.String,
          variants: Schema.optionalKey(Schema.Array(Model.VariantID)),
        }),
      ),
    )(await connection.client.request("model_catalog"))
  return {
    storageRoot,
    command: (input) =>
      Effect.gen(function* () {
        if (!preparation.command)
          return yield* Effect.fail(
            new EngineError("command_capture_unavailable", "Native command capture is not configured"),
          )
        const connection = yield* connect({ ...input, refreshContext: true })
        const snapshot = yield* Effect.tryPromise({
          try: () => connection.client.request("snapshot", { session_id: input.sessionID }),
          catch: (error) => error,
        })
        const sessionAgent = Schema.decodeUnknownSync(
          Schema.Struct({ agent: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))) }),
        )(snapshot).agent?.name
        const catalog = yield* Effect.tryPromise({ try: () => routes(connection), catch: (error) => error })
        const captured = yield* preparation.command(input, catalog, sessionAgent)
        const admit = (resume: boolean) =>
          connection.session.promptProduct({
            sessionID: input.sessionID,
            id: input.id,
            prompt: { text: captured.text, command: captured.command },
            command: captured.command,
            agentReferences: captured.agentReferences,
            resume,
          })
        yield* Effect.tryPromise({
          try: () => admit(input.resume ?? false),
          catch: (error) => error,
        }).pipe(
          // The engine refuses an open-boundary overflow on purpose: the turn
          // boundary must close before a compaction pass can run. Compact,
          // wait for the pass to commit, then re-admit the exact prompt once —
          // durable-input reconciliation makes the retry idempotent.
          Effect.catch((error) =>
            Effect.tryPromise(async () => {
              if (
                !(error instanceof Error) ||
                !error.message.includes("selected history exceeds budget")
              )
                throw error
              const seen = await Effect.runPromise(
              Effect.tryPromise({
                try: () =>
                  connection.client.request("events", {
                    session_id: input.sessionID,
                    after: "",
                  }) as Promise<Array<{ seq?: number }>>,
                catch: (cause) => cause,
              }).pipe(Effect.catch(() => Effect.succeed(undefined))),
            ).catch(() => undefined)
            const cursor = Array.isArray(seen)
              ? Math.max(0, ...seen.map((event) => event?.seq ?? 0))
              : 0
            await connection.client.request("request_compact", {
              session_id: input.sessionID,
            })
            await connection.client.request("wake", { session_id: input.sessionID })
            const deadline = Date.now() + 180_000
            let compacted = false
            while (Date.now() < deadline && !compacted) {
              await Bun.sleep(2_000)
              const events = (await Effect.runPromise(
                Effect.tryPromise({
                  try: () =>
                    connection.client.request("events", {
                      session_id: input.sessionID,
                      after: String(cursor),
                    }) as Promise<Array<{ type?: string }>>,
                  catch: (cause) => cause,
                }).pipe(Effect.catch(() => Effect.succeed(undefined))),
              ).catch(() => undefined)) as Array<{ type?: string }> | undefined
              compacted =
                Array.isArray(events) &&
                events.some((event) => event?.type === "history.compacted")
            }
            if (!compacted) throw error
            await admit(true)
          })),
        )
      }).pipe(Effect.mapError((error) => refusal(input.sessionID, error))),
    shell: (input) =>
      read(input, async (connection) => {
        const callID = input.id ?? Event.ID.create()
        const admitted = await connection.client.request("shell", {
          session_id: input.sessionID,
          call_id: callID,
          command: input.command,
          timeout_ms: 120_000,
        })
        const status = Schema.Struct({ state: Schema.String })
        const deadline = Date.now() + 15 * 60_000
        let receipt = Schema.decodeUnknownSync(status)(admitted)
        while (receipt.state === "pending" || receipt.state === "running") {
          if (Date.now() >= deadline)
            throw new EngineError(
              "operator_shell_wait_timeout",
              `session.shell ${callID} did not settle before the wait deadline; inspect its durable receipt before retrying`,
            )
          await Bun.sleep(50)
          receipt = Schema.decodeUnknownSync(status)(
            await connection.client.request("shell_status", { session_id: input.sessionID, call_id: callID }),
          )
        }
        if (receipt.state !== "ended")
          throw new EngineError(
            "operator_shell_refused",
            `session.shell ${callID} ${receipt.state}; inspect the recorded refusal or unknown outcome`,
          )
        if (input.resume !== false) await connection.client.request("wake", { session_id: input.sessionID })
      }).pipe(Effect.asVoid),
    inject: (input) =>
      read(input, async (connection) => {
        await connection.client.request("inject", {
          session_id: input.sessionID,
          ...(input.id ? { input_id: input.id } : {}),
          text: input.text,
          source: input.source,
        })
        if (input.resume !== false) await connection.client.request("wake", { session_id: input.sessionID })
      }).pipe(Effect.asVoid),
    selectAccount: (input) =>
      read(input, (connection) =>
        connection.client.request("select_account", {
          session_id: input.sessionID,
          credential_id: input.credentialID,
        }),
      ).pipe(Effect.asVoid),
    selectAgent: (input) =>
      read(input, async (connection) =>
        connection.client.request("select_agent", {
          session_id: input.sessionID,
          agent: agentManifest(input.agent, await routes(connection)),
        }),
      ).pipe(Effect.asVoid),
    modelRoutes: (input) =>
      read<readonly SessionModelRoute.Info[]>(input, async (connection) => {
        await connection.client.request("snapshot", { session_id: input.sessionID })
        return (await routes(connection)).map((entry) => ({
          model: SessionModelRoute.reference(entry.route_id),
          ...(entry.model_key
            ? {
                productModel: Schema.decodeUnknownSync(Model.Ref)({
                  providerID: entry.model_key.split("/")[0],
                  id: entry.model_key.split("/").slice(1).join("/"),
                }),
              }
            : {}),
          ...(entry.credential_id ? { credentialID: entry.credential_id } : {}),
          protocol: entry.protocol,
          wireModel: entry.model,
          default: entry.route_id === null,
          ...(entry.variants?.length ? { variants: entry.variants } : {}),
        }))
      }),
    selectModel: (input) =>
      read(input, async (connection) => {
        const binding = modelRoute(input.model, await routes(connection))
        return connection.client.request("select_model", {
          session_id: input.sessionID,
          binding: binding.route_id === null && input.model.variant === undefined ? null : binding,
        })
      }).pipe(Effect.asVoid),
    recoveries: (input) =>
      read<ReturnType<typeof NativeRecovery.page>>(input, async (connection) =>
        NativeRecovery.page(
          await connection.client.request("recoveries", { session_id: input.sessionID, after: input.after ?? "" }),
        ),
      ),
    resolveRecovery: (input) =>
      read<ReturnType<typeof NativeRecovery.resolution>>(input, async (connection) =>
        NativeRecovery.resolution(await connection.session.resolveRecovery(input)),
      ),
    initialize: (input) =>
      read(input, (connection) =>
        connection.client.request("initialize", { session_id: input.sessionID, title: input.title }),
      ).pipe(Effect.asVoid),
    cancelInput: (input) =>
      read<unknown>(input, (connection) =>
        connection.client.request("cancel_input", {
          session_id: input.sessionID,
          input_id: input.inputID,
        }),
      ).pipe(Effect.map((value) => Schema.decodeUnknownSync(AcceptedReply)(value).accepted)),
    revertStage: (input) =>
      read(input, async (connection) => {
        const snapshot = Schema.decodeUnknownSync(Schema.Struct({ cursor: Schema.Number }))(
          await connection.client.request("snapshot", { session_id: input.sessionID }),
        )
        let after = 0
        const events: EngineEvent[] = []
        while (after < snapshot.cursor) {
          const page = Schema.decodeUnknownSync(
            Schema.Array(
              Schema.Struct({
                session_id: Schema.String,
                seq: Schema.Number,
                kind: Schema.String,
                data: Schema.Unknown,
              }),
            ),
          )(await connection.client.request("events", { session_id: input.sessionID, after }))
          const next = page.at(-1)?.seq
          if (next === undefined || next <= after)
            throw new EngineError("invalid_cursor", "Native message cursor did not advance")
          events.push(...page.filter((event) => event.seq <= snapshot.cursor))
          after = next
        }
        const boundary = engineMessageSequence(input.sessionID, input.messageID, events)
        if (boundary === undefined)
          throw new EngineError("message_not_found", "No committed message for this public ID in the Session")
        return connection.client.request("revert_stage", {
          session_id: input.sessionID,
          boundary_seq: boundary,
        })
      }),
    revertClear: (input) =>
      read(input, (connection) => connection.client.request("revert_clear", { session_id: input.sessionID })),
    revertCommit: (input) =>
      read(input, (connection) => connection.client.request("revert_commit", { session_id: input.sessionID })),
    requestCompact: (input) =>
      read<unknown>(input, (connection) =>
        connection.client.request("request_compact", { session_id: input.sessionID }),
      ).pipe(Effect.asVoid),
    archive: (input) =>
      read<unknown>(input, (connection) =>
        connection.client.request("archive", {
          session_id: input.sessionID,
          archived: input.archived,
        }),
      ).pipe(Effect.map((value) => Schema.decodeUnknownSync(AcceptedReply)(value).accepted)),
    remove: (input) =>
      read<unknown>(input, (connection) => connection.client.request("remove", { session_id: input.sessionID })).pipe(
        Effect.asVoid,
      ),
    admit: (input) =>
      Effect.gen(function* () {
        const prompt = yield* preparation.prompt ? preparation.prompt(input) : Effect.succeed(input.prompt)
        const connection = yield* connect({ ...input, refreshContext: true })
        const mentions = prompt.agents ?? []
        if (mentions.length && !preparation.agents)
          return yield* Effect.fail(
            new EngineError("agent_capture_unavailable", "Native agent reference capture is not configured"),
          )
        // The catalog rides every admission, not only @-mentions: the engine
        // resolves the task tool's named subagents against it.
        const agentReferences = preparation.agents
          ? yield* preparation.agents(input, mentions, yield* Effect.tryPromise(() => routes(connection)))
          : undefined
        return yield* Effect.tryPromise(() =>
          connection.session.promptProduct({
            sessionID: input.sessionID,
            prompt,
            id: input.id,
            delivery: input.delivery,
            resume: input.resume,
            agentReferences,
          }),
        )
      }).pipe(Effect.mapError((error) => refusal(input.sessionID, error))),
    snapshot: (input) =>
      read<Readonly<Record<string, unknown>>>(input, (connection) =>
        connection.client.request("snapshot", { session_id: input.sessionID }),
      ).pipe(Effect.map((value) => (typeof value === "object" && value !== null ? value : {}))),
    usage: (input) =>
      read<Readonly<Record<string, unknown>>>(input, (connection) =>
        connection.client.request("usage", { session_id: input.sessionID }),
      ).pipe(Effect.map((value) => (typeof value === "object" && value !== null ? value : {}))),
    transcript: (input) =>
      read(input, (connection) =>
        readTranscript({
          ...input,
          engineID: input.storage,
          pricing,
          request: (method, params) => connection.client.request(method, params),
        }),
      ),
    interruptIf: (input) =>
      read(input, async (connection) => {
        const result = await connection.client.request("cancel_if", {
          session_id: input.sessionID,
          run_id: input.executionID,
        })
        return Schema.decodeUnknownSync(Schema.Struct({ accepted: Schema.Boolean }))(result).accepted
      }),
    interrupt: (input) =>
      read(input, (connection) => connection.client.request("cancel", { session_id: input.sessionID })).pipe(
        Effect.asVoid,
      ),
    rename: (input) =>
      read(input, async (connection) => {
        // Rust's rename can initialize a Session; the product command operates
        // only on an existing owner, so missing identity must fail first.
        await connection.client.request("snapshot", { session_id: input.sessionID })
        return connection.client.request("rename", { session_id: input.sessionID, title: input.title })
      }).pipe(Effect.asVoid),
    permissions: (input) =>
      read<readonly Permission.Request[]>(input, async (connection) => {
        const snapshot = await connection.client.request("snapshot", { session_id: input.sessionID })
        return Schema.decodeUnknownSync(ApprovalBindings)(snapshot).approvals.map((binding) => {
          if (binding.session_id !== input.sessionID)
            throw new EngineError("approval_owner_mismatch", "Approval belongs to another Session")
          return Schema.decodeUnknownSync(Permission.Request)(
            translateApproval({
              session_id: input.sessionID,
              seq: 0,
              kind: "approval.requested",
              data: binding,
            }),
          )
        })
      }),
    replyPermission: (input) =>
      read(input, async (connection) => {
        const snapshot = await connection.client.request("snapshot", { session_id: input.sessionID })
        const binding = Schema.decodeUnknownSync(ApprovalBindings)(snapshot).approvals.find(
          (binding) => binding.session_id === input.sessionID && `per_${binding.request_id}` === input.requestID,
        )
        if (!binding) throw new EngineError("approval_not_found", "No pending approval in this Session")
        const response = {
          request_id: binding.request_id,
          input_hash: binding.input_hash,
          policy_revision: binding.policy_revision,
          decision: input.reply === "reject" ? ("deny" as const) : ("allow" as const),
        }
        if (input.reply === "always")
          return connection.client.request("approve_persistent", { session_id: input.sessionID, response })
        return connection.client.approve(input.sessionID, response)
      }).pipe(Effect.asVoid),
    questions: (input) =>
      read<readonly Question.Request[]>(input, async (connection) => {
        const pending = await connection.client.request("questions", { session_id: input.sessionID })
        return Schema.decodeUnknownSync(QuestionBindings)(pending).map((binding) =>
          Schema.decodeUnknownSync(Question.Request)(
            translateQuestion({
              session_id: input.sessionID,
              seq: 0,
              kind: "question.requested",
              data: binding,
            }),
          ),
        )
      }),
    replyQuestion: (input) =>
      read(input, async (connection) => {
        const pending = await connection.client.request("questions", { session_id: input.sessionID })
        const binding = Schema.decodeUnknownSync(QuestionBindings)(pending).find(
          (binding) => `que_${binding.question_id}` === input.requestID,
        )
        if (!binding) throw new EngineError("question_not_found", "No pending question in this Session")
        return connection.client.answerQuestion(input.sessionID, {
          question_id: binding.question_id,
          input_hash: binding.input_hash,
          answers: input.answers,
        })
      }).pipe(Effect.asVoid),
    rejectQuestion: (input) =>
      read(input, async (connection) => {
        const value = await connection.client.request("questions", { session_id: input.sessionID })
        const pending = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ question_id: Schema.String, input_hash: Schema.String })),
        )(value)
        const binding = pending.find((request) => `que_${request.question_id}` === input.requestID)
        if (!binding) throw new EngineError("question_not_found", "No pending question in this Session")
        return connection.client.request("reject_question", {
          session_id: input.sessionID,
          rejection: { question_id: binding.question_id, input_hash: binding.input_hash },
        })
      }).pipe(Effect.asVoid),
    fork: (input) =>
      read(input, async (connection) => {
        const snapshot = Schema.decodeUnknownSync(
          Schema.Struct({
            cursor: Schema.Number,
            title: Schema.String,
            messages: Schema.Array(Schema.Struct({ seq: Schema.Number })),
          }),
        )(await connection.client.request("snapshot", { session_id: input.sessionID }))
        let boundary: number | undefined
        if (input.messageID) {
          let after = 0
          const events: EngineEvent[] = []
          while (after < snapshot.cursor) {
            const page = Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  session_id: Schema.String,
                  seq: Schema.Number,
                  kind: Schema.String,
                  data: Schema.Unknown,
                }),
              ),
            )(await connection.client.request("events", { session_id: input.sessionID, after }))
            const next = page.at(-1)?.seq
            if (next === undefined || next <= after)
              throw new EngineError("invalid_cursor", "Native message cursor did not advance")
            events.push(...page.filter((event) => event.seq <= snapshot.cursor))
            after = next
          }
          boundary = engineMessageSequence(input.sessionID, input.messageID, events)
          const settledCommand = events.find(
            (event) =>
              event.seq === boundary && (event.kind === "command.completed" || event.kind === "command.failed"),
          )
          const prepared = settledCommand
            ? Schema.decodeUnknownOption(Schema.Struct({ message_seq: Schema.Number }))(settledCommand.data)
            : Option.none()
          if (
            boundary === undefined ||
            !snapshot.messages.some(
              (message) =>
                message.seq === boundary || (Option.isSome(prepared) && message.seq === prepared.value.message_seq),
            )
          )
            throw new EngineError("message_not_found", "No committed message for this public ID in the Session")
        }
        await connection.client.request("fork", {
          session_id: input.sessionID,
          target_session_id: input.targetSessionID,
          ...(boundary === undefined ? {} : { message_seq: boundary }),
        })
        // Engine forks start with their own empty title; preserving the source
        // title is a product choice, not a global change for engine/subagents.
        await connection.client.request("rename", { session_id: input.targetSessionID, title: snapshot.title })
      }),
    sessions: (input) =>
      // `sessions` is a unit command: it takes no params.
      read<readonly unknown[]>(input, (connection) => connection.client.request("sessions")).pipe(
        Effect.map((value) => (Array.isArray(value) ? value : [])),
      ),
    history: (input) =>
      read<NativeEngine.NativeJournalPage & { readonly hasMore: boolean }>(input, (connection) =>
        replayJournal({
          ...input,
          engineID: input.storage,
          pricing,
          request: (method, params) => connection.client.request(method, params),
        }),
      ),
    title: (input) =>
      (preparation.title?.(input) ?? Effect.succeed(undefined)).pipe(Effect.catch(() => Effect.succeed(undefined))),
    events: (input) =>
      connect(input).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () =>
              replayJournal({
                ...input,
                engineID: input.storage,
                pricing,
                request: (method, params) => connection.client.request(method, params),
              }),
            catch: (error) => refusal(input.sessionID, error),
          }),
        ),
        Effect.mapError((error) => refusal(input.sessionID, error)),
      ),
  }
}
const layer = Layer.effect(
  NativeEngine.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const credentials = yield* Credential.Service
    const mcpAuth = yield* McpAuth.Service
    const locations = yield* LocationServiceMap.Service
    // The layer's install scope backs location runtimes built for title
    // generation; they live (and memoize) for as long as this layer does.
    const layerScope = yield* Effect.scope
    const buildLocationRuntime = (location: Location.Ref) =>
      Layer.buildWithMemoMap(locations.get(location), memoMap, layerScope)
    const llm = yield* LLMClient.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const ownershipService = yield* SessionOwnership.Service
    // Workflow subagents create first-class product Sessions from the
    // product-tool bridge; present only when the composition provides the
    // product session-creation service.
    const creation = Option.getOrUndefined(yield* Effect.serviceOption(SessionCreate.Service))
    const blob = yield* Blob.Service
    const fs = yield* FSUtil.Service
    const settings = yield* Effect.promise(() => engineSettings(global.config))
    const compaction = yield* Effect.promise(() => compactionSettings(global.config))
    const sandbox = yield* Effect.promise(() => sandboxSettings(global.config))
    const configuration = nativeEngineOptions(process.env, settings)
    if (!configuration) return yield* Effect.die("NativeEngine layer built without MIAO_ENGINE_BIN")
    if (process.env.MIAO_ENGINE_WORKER === "1") {
      // Opt-in ADR-12 worker host: serve the workspace's custom tools to the
      // engine. The config lives outside any model-writable workspace (tmp),
      // and its argv is static because the engine names the workspace in the
      // `hello` handshake.
      const workerConfigFile = path.join(os.tmpdir(), "miao-engine-worker-config.json")
      const host = path.resolve(import.meta.dir, "worker-host.ts")
      yield* Effect.promise(() => Bun.write(workerConfigFile, JSON.stringify({ argv: [process.execPath, host] })))
      configuration.workerConfigFile = workerConfigFile
      console.log("[worker-host] config written:", workerConfigFile)
    }
    const mcp = yield* ProductMcp.prepare(configuration).pipe(Effect.provideService(McpAuth.Service, mcpAuth))
    let ownerRouter: Owners | undefined
    // Journal replays price with the same catalog the live connection got; the
    // per-Location prepare refreshes it whenever an owner connects.
    let locationPricing: EnginePricing | undefined
    const owners = yield* makeEngineOwners({ ...configuration, ...mcp }, (location) =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const { prices, ...routes } = yield* ProductRoutes.prepare(location, configuration, compaction).pipe(
          Effect.provideService(Credential.Service, credentials),
        )
        locationPricing = prices && ((model: string) => prices[model])
        const effective = { ...configuration, ...routes, ...mcp }
        const context = yield* AmbientContext.prepare(location, effective)
        const hooks = yield* ProductHooks.prepare(location, { ...effective, ...context.options })
        const lsp = yield* ProductLsp.prepare(location, effective)
        const formatter = yield* ProductFormatter.prepare(location, effective)
        const policy = yield* ProductPolicy.prepare(effective, sandbox)
        const productTools = yield* ProductTools.prepare(configuration, creation, {
          get: (input) =>
            ownerRouter === undefined
              ? Effect.fail(new EngineError("engine_owner_closed", "product tool router is not ready"))
              : ownerRouter.get(input),
        }).pipe(Effect.provide(locations.get(location)))
        const pluginHooks = yield* PluginHooks.prepare({ ...configuration, ...productTools }, { store: sessions })
        return {
          options: {
            ...routes,
            ...mcp,
            ...context.options,
            ...hooks,
            ...lsp,
            ...formatter,
            ...policy,
            ...productTools,
            ...pluginHooks,
          },
          refresh: context.refresh,
          pricing: prices && ((model: string) => prices[model]),
          onCredentialExpired: (input: { sessionID: string; id: string; integration: string }) =>
            Effect.runPromise(
              Effect.gen(function* () {
                // ADR-09: daemon-owned rows refresh on read and the daemon
                // stays the sole writer. Only explicitly owned Google-account
                // methods may otherwise refresh in this TS host.
                const row = yield* credentials.get(Credential.ID.make(input.id))
                if (!row || row.integrationID !== input.integration) return false
                const socket = CredentialDaemon.socket(row.value)
                if (socket)
                  yield* Effect.tryPromise({
                    try: () => CredentialDaemon.get(socket, input.id, input.integration),
                    catch: (cause) => new Error(String(cause)),
                  })
                else {
                  // This built-in method explicitly owns its refresh in the TS
                  // host. Daemon-owned and inherited read-only rows keep their
                  // existing ownership checks; the engine never writes tokens.
                  if (!GoogleAccount.owns(row.integrationID, row.value)) return false
                  const fresh = yield* integrations.connection.resolve({
                    type: "credential",
                    id: Credential.ID.make(input.id),
                    label: row.label,
                    active: row.active ?? false,
                  })
                  if (fresh?.type !== "oauth" || fresh.expires <= Date.now()) return false
                }
                return true
              }),
            ),
        }
      }).pipe(
        Effect.provide(locations.get(location)),
        Effect.provideService(Database.Service, database),
        Effect.provideService(SessionStore.Service, sessions),
        Effect.provideService(SessionOwnership.Service, ownershipService),
        Effect.mapError((error) =>
          error instanceof EngineError
            ? error
            : new EngineError("engine_context_unavailable", "could not prepare product Context for native Location"),
        ),
      ),
    )
    ownerRouter = owners
    // Supervisor tick: probe every live owner's timer sessions; a dead child
    // is transparently re-owned so its adopted timers re-arm and fire.
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("60 seconds")
        yield* Effect.ignore(owners.sweepTimers())
      }),
    ).pipe(Effect.forkScoped)
    // Native steps never enter the TypeScript journal, so their turn usage is
    // projected straight off the translated live event; the engine-stable
    // event id keeps a replayed projection inserting at most once.
    const clients = yield* ClientEvents.Service
    const unsubscribeUsage = yield* clients.listen((event) =>
      event.type === "session.next.step.ended" && event.metadata?.engine !== undefined
        ? SessionUsageStore.projectNativeStepEnded(database.db, event)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribeUsage)
    const engine = fromOwners(
      owners,
      {
        prompt: (input) =>
          PromptMaterialization.prepare(input.prompt).pipe(
            Effect.provideService(Blob.Service, blob),
            Effect.provideService(FSUtil.Service, fs),
          ),
        command: (input, catalog, sessionAgent) =>
          Effect.gen(function* () {
            const { ProductCommand } = yield* Effect.promise(() => import("./product-command"))
            return yield* ProductCommand.capture({
              definition: input.definition,
              arguments: input.arguments,
              catalog,
              sessionAgent,
            })
          }).pipe(Effect.provide(locations.get(input.location))),
        agents: (input, mentions, catalog) =>
          Effect.gen(function* () {
            const { ProductCommand } = yield* Effect.promise(() => import("./product-command"))
            return yield* ProductCommand.references(mentions, catalog)
          }).pipe(Effect.provide(locations.get(input.location))),
        title: (input: Parameters<NativeEngine.Interface["title"]>[0]) =>
          Effect.gen(function* () {
            const runtime = yield* buildLocationRuntime(input.location)
            const locationContext = runtime as unknown as Context.Context<
              AgentV2.Service | EventV2.Service | SessionRunnerModel.Service
            >
            return yield* SessionNativeTitle.afterRun({
              sessionID: input.sessionID,
              prompt: input.prompt,
              store: sessions,
              llm: llm,
              agents: Context.get(locationContext, AgentV2.Service),
              models: Context.get(locationContext, SessionRunnerModel.Service),
              events: Context.get(locationContext, EventV2.Service),
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          }),
      },
      engineStorageRoot(process.env, settings),
      (model: string) => locationPricing?.(model),
    )
    // Native Sessions settle through the engine's own lifecycle events, and
    // the TUI never calls session.wait — so the wait handler's title hook
    // never fires interactively and the first exchange kept its creation
    // placeholder forever. Pump idle transitions through the same
    // generateNativeTitle the wait handler uses; the queue keeps the LLM call
    // off the client fan-out, and the core guard inside the title hook makes
    // repeat idle transitions of a titled Session cost one history read.
    const pendingTitles = yield* Queue.unbounded<NativeTitleRequest>()
    const scheduledTitles = new Set<string>()
    const titleAttempts = new Map<string, number>()
    const scheduleTitle = (request: NativeTitleRequest) =>
      Effect.gen(function* () {
        const key = `${request.storage}:${request.sessionID}`
        if (scheduledTitles.has(key) || Date.now() - (titleAttempts.get(key) ?? 0) < 60_000) return
        scheduledTitles.add(key)
        titleAttempts.set(key, Date.now())
        yield* Queue.offer(pendingTitles, request)
      })
    yield* Effect.forever(
      Effect.gen(function* () {
        const request = yield* Queue.take(pendingTitles)
        yield* generateNativeTitle({ native: engine, ...request }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("native title generation skipped", { cause })),
          Effect.ensuring(Effect.sync(() => scheduledTitles.delete(`${request.storage}:${request.sessionID}`))),
        )
      }),
    ).pipe(Effect.forkScoped)
    const unsubscribeTitle = yield* clients.listen((event) => {
      if (event.type !== "session.next.status" || event.metadata?.engine === undefined) return Effect.void
      const data = event.data as { sessionID?: NativeTitleRequest["sessionID"]; status?: { type?: string } }
      const storage = engineStorageID(event)
      if (data.status?.type !== "idle" || data.sessionID === undefined || storage === undefined) return Effect.void
      if (event.location === undefined) return Effect.void
      return scheduleTitle({
        sessionID: data.sessionID,
        storage,
        location: event.location,
      }).pipe(Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribeTitle)
    return NativeEngine.Service.of({
      ...engine,
      snapshot: (input) =>
        engine.snapshot(input).pipe(
          Effect.tap((snapshot) =>
            Effect.gen(function* () {
              if (typeof snapshot.title !== "string") return
              if (!SessionTitle.isDefault(snapshot.title)) {
                const current = yield* sessions.get(input.sessionID)
                if (current && current.title !== snapshot.title)
                  yield* events.publish(SessionEvent.Info.Updated, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    title: snapshot.title,
                  })
                return
              }
              if (snapshot.active_run || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return
              yield* scheduleTitle(input)
            }),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: NativeEngine.Service,
  layer,
  deps: [
    ClientEvents.node,
    Global.node,
    Credential.node,
    McpAuth.node,
    LocationServiceMap.node,
    Blob.node,
    FSUtil.node,
    Database.node,
    EventV2.node,
    SessionStore.node,
    SessionCreate.node,
    SessionOwnership.node,
    llmClient,
  ],
})

export * as NativeEngineNode from "./native-engine"
