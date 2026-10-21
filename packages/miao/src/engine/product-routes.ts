import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { CopilotModels } from "@miao/core/github-copilot/models"
import { shouldUseResponsesApi } from "@miao/llm/providers/github-copilot"
import { DatabaseFile } from "@miao/core/database/file"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { Deferred, Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

type Source =
  | { type: "database"; path: string; id: string; integration: string }
  | { type: "environment"; key: string }
  | { type: "aws"; region: string; profile?: string }

type Account = { source: Source; oauth: boolean; value?: Credential.Value; id?: string; isDefault: boolean }

/**
 * Automatic context management for the native engine, derived from the product
 * compaction settings so a native Session behaves like a TypeScript one.
 *
 * The engine runs one process per Location, so its trigger is one window: the
 * default model's. The headroom mirrors the TypeScript formula — the tool output
 * pruning protects, the summary reserve, and the configured slack — and the
 * ratio is the same threshold. `auto: false` keeps the trigger off, and an
 * explicit `engine.context_limits` always wins.
 */
export const contextLimitsFor = (
  model: { readonly limit: { readonly context: number } },
  compaction:
    | { readonly auto?: boolean; readonly threshold?: number; readonly buffer?: number }
    | undefined,
) => {
  if (compaction?.auto === false) return undefined
  const window = model.limit.context
  if (!Number.isFinite(window) || window <= 0) return undefined
  return {
    window,
    ratio: compaction?.threshold ?? 0.9,
    headroom: 40_000 + 2_048 + (compaction?.buffer ?? 20_000),
    perPass: 8,
  }
}

/** Resolve the served model for the compaction trigger on an explicit route.
 * Best effort: without the configured model in the catalog (provider plugins
 * not booted, worker or test contexts) the engine default stands. */
const explicitModel = (catalog: Catalog.Interface, model: string | undefined) =>
  Effect.gen(function* () {
    const capable = (yield* catalog.model.available()).filter(
      (candidate) => candidate.capabilities.tools && candidate.capabilities.output.includes("text"),
    )
    const selected = model
      ? capable.filter(
          (candidate) => `${candidate.providerID}/${candidate.id}` === model || candidate.api.id === model,
        )
      : [yield* catalog.model.default()]
    return selected.length === 1 ? selected[0] : undefined
  })

/** Build exact host routes from the product catalog and active connections.
 * The manifest holds credential references only; refresh stays with its owner. */
export const prepare = Effect.fn("Engine.productRoutes")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
  compaction?: { readonly auto?: boolean; readonly threshold?: number; readonly buffer?: number },
) {
  const options: Partial<EngineOptions> = {}
  // Explicit routes skip the generated manifest, but automatic compaction must
  // still track the served model: derive the trigger from its window unless
  // the operator configured engine.context_limits. The product-generated path
  // re-derives below after the plugins boot, which also covers provider-plugin
  // models this best-effort pass cannot see yet.
  if (configuration.contextLimits === undefined) {
    const catalog = Option.getOrUndefined(yield* Effect.serviceOption(Catalog.Service))
    const model = catalog ? yield* explicitModel(catalog, configuration.model) : undefined
    const derived = model ? contextLimitsFor(model, compaction) : undefined
    if (derived) options.contextLimits = derived
  }
  if (
    configuration.modelRoutesConfigFile ||
    configuration.provider ||
    configuration.endpoint ||
    configuration.credentialDatabase ||
    configuration.credentialID ||
    configuration.credentialIntegration
  )
    return { ...options, prices: undefined }
  const catalog = Option.getOrUndefined(yield* Effect.serviceOption(Catalog.Service))
  const integrations = Option.getOrUndefined(yield* Effect.serviceOption(Integration.Service))
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(Credential.Service))
  if (!catalog || !integrations) return { ...options, prices: undefined }
  if (!credentials)
    return yield* Effect.fail(
      new EngineError(
        "engine_routes_credentials",
        "product routes require the global credential broker in the native owner context",
      ),
    )
  // Provider plugins populate model metadata and active connections during boot.
  const plugins = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
  if (plugins) yield* Deferred.await(plugins.booted)
  const current = yield* Location.Service
  if (current.directory !== location.directory)
    return yield* Effect.fail(new EngineError("engine_routes_location", "product model Location does not match owner"))
  const models = (yield* catalog.model.available()).filter(
    (model) => model.capabilities.tools && model.capabilities.output.includes("text"),
  )
  // The engine journals the serving model's api id with each usage event; this
  // index prices those ids at the catalog's tiered rates.
  const prices: Record<string, ModelV2.Info["cost"]> = Object.fromEntries(
    models.map((model) => [model.api.id, model.cost]),
  )
  const selected = configuration.model
    ? models.filter(
        (model) => `${model.providerID}/${model.id}` === configuration.model || model.api.id === configuration.model,
      )
    : [yield* catalog.model.default()].filter((model) => model !== undefined)
  if (selected.length !== 1)
    return yield* Effect.fail(
      new EngineError(
        "engine_routes_model",
        "native startup requires one available product model; use its full provider/model id",
      ),
    )
  const defaultModel = selected[0]
  if (!defaultModel) return yield* Effect.fail(new EngineError("engine_routes_model", "no available product model"))
  const shared = yield* Credential.SharedDatabasePath
  const providers = yield* catalog.provider.available()
  const accounts = new Map<string, Account[]>()
  for (const provider of providers) {
    const integration = provider.integrationID ?? Integration.ID.make(provider.id)
    if (accounts.has(integration)) continue
    // Bedrock uses the AWS SDK default chain rather than a product credential.
    // Region/profile are host configuration; no secret enters the manifest.
    if (provider.id === "amazon-bedrock") {
      const settings = provider.api.type === "aisdk" ? provider.api.settings : undefined
      const region =
        (typeof settings?.region === "string" ? settings.region : undefined) ??
        (typeof provider.request.body.region === "string" ? provider.request.body.region : undefined) ??
        process.env.AWS_REGION ??
        "us-east-1"
      const profile =
        (typeof settings?.profile === "string" ? settings.profile : undefined) ??
        (typeof provider.request.body.profile === "string" ? provider.request.body.profile : undefined) ??
        process.env.AWS_PROFILE
      const bearer = process.env.AWS_BEARER_TOKEN_BEDROCK
      accounts.set(integration, [
        {
          source: bearer
            ? { type: "environment", key: "AWS_BEARER_TOKEN_BEDROCK" }
            : { type: "aws", region, ...(profile === undefined ? {} : { profile }) },
          oauth: false,
          ...(bearer ? { value: { type: "key" as const, key: bearer } } : {}),
          isDefault: true,
        },
      ])
      continue
    }
    const connection = yield* integrations.connection.active(integration)
    if (!connection) continue
    const credential = connection.type === "env" ? undefined : yield* credentials.get(connection.id)
    // Copilot device grants use zero expiry; generic OAuth resolution treats it as expired.
    const device =
      integration === "github-copilot" &&
      credential?.value.type === "oauth" &&
      credential.value.expires === 0 &&
      credential.value.refresh.length > 0
    const value = device
      ? credential.value
      : yield* integrations.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!value) continue
    const entries: Account[] = []
    if (connection.type === "env") {
      entries.push({ source: { type: "environment", key: connection.name }, oauth: false, value, isDefault: true })
    } else {
      const credential = yield* credentials.get(connection.id)
      if (!credential || credential.integrationID !== integration) continue
      const database = credential.source === "shared" ? shared : DatabaseFile.path()
      if (!database || database === ":memory:") continue
      entries.push({
        source: { type: "database", path: database, id: credential.id, integration },
        id: credential.id,
        oauth: value.type === "oauth",
        value,
        isDefault: true,
      })
    }
    // Resolving an alternative never activates it globally. The broker remains
    // the only refresh writer; the engine receives references, not secrets.
    for (const credential of yield* credentials.list(integration)) {
      if (entries.some((entry) => entry.id === credential.id)) continue
      const database = credential.source === "shared" ? shared : DatabaseFile.path()
      if (!database || database === ":memory:") continue
      const alternate =
        integration === "github-copilot" &&
        credential.value.type === "oauth" &&
        credential.value.expires === 0 &&
        credential.value.refresh.length > 0
          ? credential.value
          : yield* integrations.connection
              .resolve({ type: "credential", id: credential.id, label: credential.label, active: false })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!alternate) continue
      entries.push({
        source: { type: "database", path: database, id: credential.id, integration },
        id: credential.id,
        oauth: alternate.type === "oauth",
        value: alternate,
        isDefault: false,
      })
    }
    accounts.set(integration, entries)
  }
  const routes = models.flatMap((model) => {
    const provider = providers.find((provider) => provider.id === model.providerID)
    const integration = provider ? (provider.integrationID ?? Integration.ID.make(provider.id)) : undefined
    const connections = integration === undefined ? undefined : accounts.get(integration)
    return (connections ?? []).flatMap((account) => {
      if (integration === undefined) return []
      const copilot = integration === "github-copilot"
      const transport = profile(model, account, integration)
      if (!transport) return []
      const headers = Object.fromEntries(
        Object.entries(model.request.headers).filter(([key]) =>
          /^(user-agent|anthropic-version|anthropic-beta|x-command-code-version|openai-beta|http-referer|x-title|x-app-name)$/i.test(
            key,
          ),
        ),
      )
      return [
        {
          id: account.isDefault
            ? `${model.providerID}/${model.id}`
            : `account/${createHash("sha256")
                .update(JSON.stringify([model.providerID, model.id, account.id]))
                .digest("hex")}`,
          account: { id: account.id ?? null, model_key: `${model.providerID}/${model.id}`, default: account.isDefault },
          ...transport,
          model: model.api.id,
          primary: account.isDefault && model.providerID === defaultModel.providerID && model.id === defaultModel.id,
          ...(model.capabilities.input.length ? { input_modalities: model.capabilities.input } : {}),
          ...(Number.isFinite(model.limit?.context) && model.limit.context > 0
            ? {
                limit: {
                  context: model.limit.context,
                  ...(Number.isFinite(model.limit.output) && model.limit.output > 0
                    ? { output: model.limit.output }
                    : {}),
                },
              }
            : {}),
          ...(model.request.variant === undefined ? {} : { default_variant: model.request.variant }),
          request: { body: model.request.body },
          variants: model.variants.map((variant) => ({
            id: variant.id,
            body: variant.body,
            headers: variant.headers,
          })),
          credential: account.source,
          auth: {
            ...(copilot
              ? { style: "copilot" }
              : transport.provider === "anthropic" && account.oauth
                ? { style: "bearer" }
                : {}),
            headers: {
              ...headers,
              ...(copilot ? { ...CopilotModels.headers(), "Openai-Intent": "conversation-edits" } : {}),
              // The trusted native transport resolves this to the current
              // Session's opaque routing key, never an owner-wide static ID.
              ...(model.providerID === "opencode-go" ? { "x-opencode-session": "$session" } : {}),
            },
          },
        },
      ]
    })
  })
  const primary = routes.find((route) => route.id === `${defaultModel.providerID}/${defaultModel.id}`)
  if (!primary)
    return yield* Effect.fail(
      new EngineError(
        "engine_routes_unsupported",
        "the selected product model has no usable native credential/provider route",
      ),
    )
  if (routes.length > 1024)
    return yield* Effect.fail(new EngineError("engine_routes_limit", "native product catalog exceeds 1024 routes"))
  if (options.contextLimits === undefined) {
    const limits = contextLimitsFor(defaultModel, compaction)
    if (limits) options.contextLimits = limits
  }
  const content = JSON.stringify(routes)
  if (Buffer.byteLength(content) > 1024 * 1024)
    return yield* Effect.fail(new EngineError("engine_routes_limit", "native product routes exceed 1 MiB"))
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(path.join(os.tmpdir(), "miao-native-routes-")),
      catch: () => new EngineError("engine_routes_io", "could not create native routes directory"),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
  const file = path.join(directory, "routes.json")
  yield* Effect.tryPromise({
    try: () => writeFile(file, content, { mode: 0o600 }),
    catch: () => new EngineError("engine_routes_io", "could not write native product routes"),
  })
  options.model = primary.model
  options.provider = primary.provider
  options.endpoint = primary.endpoint
  options.modelRoutesConfigFile = file
  const environment = Array.from(accounts.values())
    .flat()
    .flatMap((account) =>
      account.source.type === "environment" && account.value
        ? [[account.source.key, account.value.type === "key" ? account.value.key : account.value.access]]
        : [],
    )
  if (environment.length) options.env = { ...configuration.env, ...Object.fromEntries(environment) }
  if (primary.credential.type === "database") {
    options.credentialDatabase = primary.credential.path
    options.credentialID = primary.credential.id
    options.credentialIntegration = primary.credential.integration
  }
  if (primary.credential.type === "environment") {
    const provider = providers.find((provider) => provider.id === defaultModel.providerID)
    const account = provider
      ? accounts.get(provider.integrationID ?? Integration.ID.make(provider.id))?.find((account) => account.isDefault)
      : undefined
    if (account?.value) {
      const key =
        primary.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : primary.provider === "gemini"
            ? "GEMINI_API_KEY"
            : "OPENAI_API_KEY"
      options.env = {
        ...configuration.env,
        ...options.env,
        [key]: account.value.type === "key" ? account.value.key : account.value.access,
      }
    }
  }
  return { ...options, prices }
})

function profile(model: ModelV2.Info, account: Account, integration: string) {
  const oauth = account.oauth
  if (model.providerID === "commandcode")
    return { provider: "openai-chat", endpoint: "https://api.commandcode.ai/provider/v1/chat/completions" }
  if (model.api.type === "native") {
    // Plugin catalogs without an AI SDK package (models.dev entries with no
    // `npm`) serve an OpenAI-compatible HTTP API at the declared base URL.
    // Map the endpoint onto the engine's openai-chat transport; credentials
    // ride the same account resolution as any other integration.
    const base = model.api.url?.replace(/\/$/, "")
    if (!base) return undefined
    const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`
    return { provider: "openai-chat", endpoint }
  }
  if (model.api.type !== "aisdk") return undefined
  if (model.api.package === "@ai-sdk/amazon-bedrock") {
    const url =
      model.api.url ?? (typeof model.request.body.endpoint === "string" ? model.request.body.endpoint : undefined)
    return { provider: "amazon-bedrock", ...(url === undefined ? {} : { endpoint: url }) }
  }
  if (integration === "github-copilot") {
    const enterprise = account.value?.type === "oauth" ? account.value.metadata?.enterpriseUrl : undefined
    const base =
      typeof enterprise === "string"
        ? CopilotModels.baseURL(enterprise)
        : (model.api.url?.replace(/\/v1\/?$/, "") ?? CopilotModels.DEFAULT_URL)
    const declared = model.api.settings?.endpoint
    if (declared !== undefined && declared !== "messages" && declared !== "responses" && declared !== "chat") return
    const wire =
      declared ??
      (model.api.package === "@ai-sdk/anthropic"
        ? "messages"
        : shouldUseResponsesApi(model.api.id)
          ? "responses"
          : "chat")
    const suffix = wire === "messages" ? "v1/messages" : wire === "responses" ? "responses" : "chat/completions"
    const url = endpoint(base, suffix)
    if (!url) return
    return {
      provider: wire === "messages" ? "anthropic" : wire === "responses" ? "openai-responses" : "openai-chat",
      endpoint: url,
    }
  }
  const defaults: Record<string, string> = {
    "@ai-sdk/deepseek": "https://api.deepseek.com/v1",
    "@ai-sdk/groq": "https://api.groq.com/openai/v1",
    "@ai-sdk/mistral": "https://api.mistral.ai/v1",
    "@ai-sdk/xai": "https://api.x.ai/v1",
  }
  const base = (model.api.url ?? defaults[model.api.package])?.replace(/\/$/, "")
  if (model.api.package === "@ai-sdk/openai") {
    if (model.providerID === "openai" && oauth)
      return { provider: "subscription-responses", endpoint: "https://chatgpt.com/backend-api/codex/responses" }
    const url = endpoint(base ?? "https://api.openai.com/v1", "responses")
    return url ? { provider: "openai-responses", endpoint: url } : undefined
  }
  if (model.api.package === "@ai-sdk/anthropic") {
    const url = endpoint(base ?? "https://api.anthropic.com/v1", "messages")
    return url ? { provider: "anthropic", endpoint: url } : undefined
  }
  if (model.api.package === "@ai-sdk/google") {
    const url = endpoint(
      base ?? "https://generativelanguage.googleapis.com/v1beta",
      `models/${model.api.id.replace(/^models\//, "")}:streamGenerateContent`,
    )
    return url ? { provider: "gemini", endpoint: url } : undefined
  }
  if (
    ["@ai-sdk/openai-compatible", "@ai-sdk/deepseek", "@ai-sdk/groq", "@ai-sdk/mistral", "@ai-sdk/xai"].includes(
      model.api.package,
    ) &&
    base
  ) {
    const url = endpoint(base, "chat/completions")
    return url ? { provider: "openai-chat", endpoint: url } : undefined
  }
  return undefined
}

function endpoint(base: string, suffix: string) {
  if (!URL.canParse(base)) return undefined
  const url = new URL(base)
  if (!["http:", "https:"].includes(url.protocol)) return undefined
  if (
    url.username ||
    url.password ||
    Array.from(url.searchParams.keys()).some((key) => /key|token|secret|auth/i.test(key))
  )
    return undefined
  const current = url.pathname.replace(/\/$/, "")
  url.pathname = current.endsWith(`/${suffix}`) ? current : `${current}/${suffix}`
  return url.toString()
}

export * as ProductRoutes from "./product-routes"
