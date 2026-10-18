import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { DatabaseFile } from "@miao/core/database/file"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { PluginV2 } from "@miao/core/plugin"
import { Deferred, Effect, Option } from "effect"
import { EngineError, type EngineOptions } from "./client"

type Source = { type: "database"; path: string; id: string; integration: string } | { type: "environment"; key: string }

/** Build exact host routes from the product catalog and active connections.
 * The manifest holds credential references only; refresh stays with its owner. */
export const prepare = Effect.fn("Engine.productRoutes")(function* (
  location: Location.Ref,
  configuration: Omit<EngineOptions, "db" | "workspace">,
) {
  const options: Partial<EngineOptions> = {}
  if (
    configuration.modelRoutesConfigFile ||
    configuration.provider ||
    configuration.endpoint ||
    configuration.credentialDatabase ||
    configuration.credentialID ||
    configuration.credentialIntegration
  )
    return options
  const catalog = Option.getOrUndefined(yield* Effect.serviceOption(Catalog.Service))
  const integrations = Option.getOrUndefined(yield* Effect.serviceOption(Integration.Service))
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(Credential.Service))
  if (!catalog || !integrations) return options
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
  const accounts = new Map<string, { source: Source; oauth: boolean; value: Credential.Value }>()
  for (const provider of providers) {
    const integration = provider.integrationID ?? Integration.ID.make(provider.id)
    if (accounts.has(integration)) continue
    const connection = yield* integrations.connection.active(integration)
    if (!connection) continue
    const value = yield* integrations.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!value) continue
    if (connection.type === "env") {
      accounts.set(integration, { source: { type: "environment", key: connection.name }, oauth: false, value })
      continue
    }
    const credential = yield* credentials.get(connection.id)
    if (!credential || credential.integrationID !== integration) continue
    const database = credential.source === "shared" ? shared : DatabaseFile.path()
    if (!database || database === ":memory:") continue
    accounts.set(integration, {
      source: { type: "database", path: database, id: credential.id, integration },
      oauth: value.type === "oauth",
      value,
    })
  }
  const routes = models.flatMap((model) => {
    const provider = providers.find((provider) => provider.id === model.providerID)
    const account = provider ? accounts.get(provider.integrationID ?? Integration.ID.make(provider.id)) : undefined
    if (!account) return []
    const transport = profile(model, account.oauth)
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
        id: `${model.providerID}/${model.id}`,
        ...transport,
        model: model.api.id,
        primary: model.providerID === defaultModel.providerID && model.id === defaultModel.id,
        ...(model.request.variant === undefined ? {} : { default_variant: model.request.variant }),
        request: { body: model.request.body },
        variants: model.variants.map((variant) => ({
          id: variant.id,
          body: variant.body,
          headers: variant.headers,
        })),
        credential: account.source,
        auth: {
          ...(transport.provider === "anthropic" && account.oauth ? { style: "bearer" } : {}),
          headers: {
            ...headers,
            // The trusted native transport resolves this to the current
            // Session's opaque routing key, never an owner-wide static ID.
            ...(model.providerID === "opencode-go" ? { "x-opencode-session": "$session" } : {}),
          },
        },
      },
    ]
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
  const environment = Array.from(accounts.values()).flatMap((account) =>
    account.source.type === "environment"
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
    const account = provider ? accounts.get(provider.integrationID ?? Integration.ID.make(provider.id)) : undefined
    if (account) {
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
  return options
})

function profile(model: ModelV2.Info, oauth: boolean) {
  if (model.providerID === "commandcode")
    return { provider: "openai-chat", endpoint: "https://api.commandcode.ai/provider/v1/chat/completions" }
  if (model.api.type !== "aisdk") return undefined
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
