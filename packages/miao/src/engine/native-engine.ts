import { LocationServiceMap } from "@miao/core/location-service-map"
import { SessionModelRoute } from "@miao/schema/session-model-route"
import { Model } from "@miao/schema/model"
import { AmbientContext } from "./ambient-context"
import { ProductHooks } from "./product-hooks"
import { ProductLsp } from "./product-lsp"
import { ProductFormatter } from "./product-formatter"
import { ProductRoutes } from "./product-routes"
import { PromptMaterialization } from "./prompt-materialization"
import { Blob } from "@miao/core/blob"
import { FSUtil } from "@miao/core/fs-util"
import type { PromptInput } from "@miao/schema/prompt-input"
import { Credential } from "@miao/core/credential"
import os from "node:os"
import path from "node:path"
import { Config } from "@miao/core/config"
import { ResponsesCacheContract, ResponsesWebSocketContract } from "@miao/schema/config"
import { Global } from "@miao/core/global"
import { makeGlobalNode } from "@miao/core/effect/app-node"
import { ClientEvents } from "@miao/server/client-events"
import { NativeEngine } from "@miao/server/native-engine"
import { ConflictError } from "@miao/protocol/errors"
import { Location } from "@miao/schema/location"
import { Effect, Layer, Option, Schema } from "effect"
import { EngineError, type EngineOptions, type EngineEvent } from "./client"
import { discoveredEngine } from "./discovery"
import { makeEngineOwners } from "./owners"
import { NativeRecovery } from "./recovery"
import { engineMessageSequence } from "./message-sequence"
import { Permission } from "@miao/schema/permission"
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
export const engineSettings = async (
  globalConfig: string,
): Promise<Omit<EngineOptions, "db" | "workspace"> | undefined> => {
  let settings: Omit<EngineOptions, "db" | "workspace"> | undefined = undefined
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
      contextLimits: engine.context_limits,
    }
  }
  const mcpSettings = Option.getOrUndefined(Config.decodeDocument(Config.merge(documents)))?.mcp
  return mcpSettings ? { ...(settings ?? { binary: "", model: "" }), mcpSettings } : settings
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

/**
 * The transport implementation over a server-scoped owner registry. Kept apart
 * from the layer so tests exercise the exact code the server runs.
 */
export const fromOwners = (
  owners: Owners,
  preparePrompt?: (input: Parameters<NativeEngine.Interface["admit"]>[0]) => Effect.Effect<PromptInput.Prompt, unknown>,
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
          protocol: Schema.String,
          model: Schema.String,
          variants: Schema.optionalKey(Schema.Array(Model.VariantID)),
        }),
      ),
    )(await connection.client.request("model_catalog"))
  return {
    modelRoutes: (input) =>
      read<readonly SessionModelRoute.Info[]>(input, async (connection) => {
        await connection.client.request("snapshot", { session_id: input.sessionID })
        return (await routes(connection)).map((entry) => ({
          model: SessionModelRoute.reference(entry.route_id),
          protocol: entry.protocol,
          wireModel: entry.model,
          default: entry.route_id === null,
          ...(entry.variants?.length ? { variants: entry.variants } : {}),
        }))
      }),
    selectModel: (input) =>
      read(input, async (connection) => {
        const entry = (await routes(connection)).find((entry) => {
          if (
            input.model.providerID !== SessionModelRoute.ProviderID &&
            input.model.providerID !== SessionModelRoute.DefaultProviderID
          )
            return entry.route_id === `${input.model.providerID}/${input.model.id}`
          const model = SessionModelRoute.reference(entry.route_id)
          return model.providerID === input.model.providerID && model.id === input.model.id
        })
        if (!entry) throw new EngineError("unknown_model_route", "Model is not in the native host route catalog")
        if (input.model.variant !== undefined && !entry.variants?.includes(input.model.variant))
          throw new EngineError("unknown_model_variant", "Variant is not in the native host route catalog")
        return connection.client.request("select_model", {
          session_id: input.sessionID,
          binding:
            entry.route_id === null && input.model.variant === undefined
              ? null
              : {
                  route_id: entry.route_id,
                  protocol: entry.protocol,
                  model: entry.model,
                  ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
                },
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
      (preparePrompt ? preparePrompt(input) : Effect.succeed(input.prompt)).pipe(
        Effect.flatMap((prompt) =>
          connect({ ...input, refreshContext: true }).pipe(
            Effect.flatMap((connection) =>
              Effect.tryPromise({
                try: () =>
                  connection.session.promptProduct({
                    sessionID: input.sessionID,
                    prompt,
                    id: input.id,
                    delivery: input.delivery,
                    resume: input.resume,
                  }),
                catch: (error) => refusal(input.sessionID, error),
              }),
            ),
          ),
        ),
        Effect.mapError((error) => refusal(input.sessionID, error)),
      ),
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
        // An engine allow is once-only. Never silently turn a persistent grant
        // into a one-off approval (or create a TS rule the engine cannot read).
        if (input.reply === "always")
          throw new EngineError(
            "persistent_approval_unavailable",
            "Native approvals are once-only; configure a native policy rule for persistent grants",
          )
        const snapshot = await connection.client.request("snapshot", { session_id: input.sessionID })
        const binding = Schema.decodeUnknownSync(ApprovalBindings)(snapshot).approvals.find(
          (binding) => binding.session_id === input.sessionID && `per_${binding.request_id}` === input.requestID,
        )
        if (!binding) throw new EngineError("approval_not_found", "No pending approval in this Session")
        return connection.client.approve(input.sessionID, {
          request_id: binding.request_id,
          input_hash: binding.input_hash,
          policy_revision: binding.policy_revision,
          decision: input.reply === "once" ? "allow" : "deny",
        })
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
          if (boundary === undefined || !snapshot.messages.some((message) => message.seq === boundary))
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
          request: (method, params) => connection.client.request(method, params),
        }),
      ),
    events: (input) =>
      connect(input).pipe(
        Effect.flatMap((connection) =>
          Effect.tryPromise({
            try: () =>
              replayJournal({
                ...input,
                engineID: input.storage,
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
    const locations = yield* LocationServiceMap.Service
    const blob = yield* Blob.Service
    const fs = yield* FSUtil.Service
    const settings = yield* Effect.promise(() => engineSettings(global.config))
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
    const owners = yield* makeEngineOwners(configuration, (location) =>
      Effect.gen(function* () {
        const routes = yield* ProductRoutes.prepare(location, configuration).pipe(
          Effect.provideService(Credential.Service, credentials),
        )
        const effective = { ...configuration, ...routes }
        const context = yield* AmbientContext.prepare(location, effective)
        const hooks = yield* ProductHooks.prepare(location, { ...effective, ...context.options })
        const lsp = yield* ProductLsp.prepare(location, effective)
        const formatter = yield* ProductFormatter.prepare(location, effective)
        return {
          options: { ...routes, ...context.options, ...hooks, ...lsp, ...formatter },
          refresh: context.refresh,
        }
      }).pipe(
        Effect.provide(locations.get(location)),
        Effect.mapError((error) =>
          error instanceof EngineError
            ? error
            : new EngineError("engine_context_unavailable", "could not prepare product Context for native Location"),
        ),
      ),
    )
    // Supervisor tick: probe every live owner's timer sessions; a dead child
    // is transparently re-owned so its adopted timers re-arm and fire.
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("60 seconds")
        yield* Effect.ignore(owners.sweepTimers())
      }),
    ).pipe(Effect.forkScoped)
    return fromOwners(owners, (input) =>
      PromptMaterialization.prepare(input.prompt).pipe(
        Effect.provideService(Blob.Service, blob),
        Effect.provideService(FSUtil.Service, fs),
      ),
    )
  }),
)

export const node = makeGlobalNode({
  service: NativeEngine.Service,
  layer,
  deps: [ClientEvents.node, Global.node, Credential.node, LocationServiceMap.node, Blob.node, FSUtil.node],
})

export * as NativeEngineNode from "./native-engine"
