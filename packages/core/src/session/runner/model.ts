export * as SessionRunnerModel from "./model"

import os from "os"
import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@miao/llm"
import * as AnthropicMessages from "@miao/llm/protocols/anthropic-messages"
import * as Gemini from "@miao/llm/protocols/gemini"
import * as OpenAIChat from "@miao/llm/protocols/openai-chat"
import * as OpenAICompatibleChat from "@miao/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@miao/llm/protocols/openai-responses"
import { Azure, GitHubCopilot } from "@miao/llm/providers"
import { openAIDefaultOptions } from "@miao/llm/providers/openai"
import { Auth, type AnyRoute } from "@miao/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { AzureEntra } from "../../azure-entra"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Flag } from "../../flag/flag"
import { GoogleCloudAuth } from "../../google-cloud-auth"
import { CopilotModels } from "../../github-copilot/models"
import { InstallationVersion } from "../../installation/version"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ModelVariants } from "../../model-variants"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID} (provider disabled, or its credentials need re-authentication)`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export type Resolved = { readonly model: Model; readonly info: ModelV2.Info }

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Resolved, Error>
  readonly resolveSmall: (session: SessionSchema.Info) => Effect.Effect<Model | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. Cost rates default to none. */
export const layerWith = (resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve: (session) =>
        resolve(session).pipe(
          Effect.map((model) => ({
            model,
            info: ModelV2.Info.empty(ProviderV2.ID.make(model.provider), ModelV2.ID.make(model.id)),
          })),
        ),
      resolveSmall: () => Effect.succeed(undefined),
    }),
  )

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

/**
 * `settings` names AI SDK provider settings that catalog plugins and the V1
 * config lowering leave in `request.body` (Azure `resourceName`, Vertex
 * `project`, ...). They configure the route, so they must not reach the wire.
 */
const withDefaults = (model: ModelV2.Info, route: AnyRoute, settings: ReadonlyArray<string> = []) => {
  const body = model.request.body
  const httpBody =
    Object.hasOwn(body, "apiKey") || settings.some((key) => Object.hasOwn(body, key))
      ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey" && !settings.includes(key)))
      : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant =
    model.variants.find((item) => item.id === id) ?? ModelVariants.generate(model).find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const userAgent = () => `miao/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

// Providers whose models.dev entry has no `api` URL but are OpenAI-compatible.
const COMPATIBLE_BASE_URLS: Record<string, string> = {
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@ai-sdk/gateway": "https://ai-gateway.vercel.sh/v1",
  "venice-ai-sdk-provider": "https://api.venice.ai/api/v1",
}

const unsupported = (model: ModelV2.Info) =>
  new UnsupportedApiError({ providerID: model.providerID, modelID: model.id, api: apiName(model) })

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved = expandAzureTemplate(
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        }),
  )
  const key = apiKey(resolved, credential)
  if (resolved.api.type !== "aisdk") return Effect.fail(unsupported(resolved))
  const bearer = key === undefined ? Auth.none : Auth.bearer(key)
  if (resolved.providerID === ProviderV2.ID.githubCopilot) return Effect.succeed(copilot(resolved, credential))
  if (resolved.api.package === "@ai-sdk/azure") return azure(resolved, credential)
  if (isVertex(resolved)) return vertex(resolved, credential)
  if (resolved.api.package === "@ai-sdk/openai") {
    // The llm OpenAI facade applies these defaults; building the route directly
    // skipped them, so reasoning models ran without the encrypted reasoning
    // include that is the only way a stateless (store: false) turn carries its
    // reasoning into the next one.
    const route = withDefaults(resolved, OpenAIResponses.route).with({
      auth: bearer,
      providerOptions: openAIDefaultOptions(resolved.api.id),
      // Match the Codex CLI client identity, as the V1 codex plugin did in `chat.headers`.
      headers:
        resolved.providerID === ProviderV2.ID.openai ? { originator: "miao", "User-Agent": userAgent() } : undefined,
    })
    if (resolved.providerID === ProviderV2.ID.openai && credential?.type === "oauth") {
      const accountID = credential.metadata?.accountID
      return Effect.succeed(
        route
          .with({
            endpoint: { baseURL: "https://chatgpt.com/backend-api/codex" },
            headers: {
              ...resolved.request.headers,
              ...(typeof accountID === "string" ? { "ChatGPT-Account-Id": accountID } : {}),
            },
            http: { body: { ...route.defaults.http?.body, store: false } },
            ...(Flag.MIAO_EXPERIMENTAL_RESPONSES_WS ? { transport: OpenAIResponses.pooledTransport } : {}),
          })
          .model({ id: resolved.api.id }),
      )
    }
    return Effect.succeed(route.model({ id: resolved.api.id }))
  }
  if (resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.package === "@ai-sdk/google") {
    return Effect.succeed(
      withDefaults(resolved, Gemini.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-goog-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route).with({ auth: bearer }).model({ id: resolved.api.id }),
    )
  }
  const baseURL = resolved.api.url ?? COMPATIBLE_BASE_URLS[resolved.api.package]
  if (baseURL) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ endpoint: { baseURL }, auth: bearer })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(unsupported(resolved))
}

/**
 * GitHub Copilot serves three wire APIs behind one token: Anthropic Messages at
 * `{base}/v1` for Claude, Responses for GPT-5 class models, and Chat for the
 * rest. The account's `/models` answer (see `CopilotModels.apply`) names the
 * endpoint; models.dev entries fall back to the same model-ID rule V1 used.
 */
const copilot = (model: ModelV2.Info, credential?: Credential.Value) => {
  const enterpriseUrl = credential?.type === "oauth" ? credential.metadata?.enterpriseUrl : undefined
  const base =
    typeof enterpriseUrl === "string"
      ? CopilotModels.baseURL(enterpriseUrl)
      : (model.api.url?.replace(/\/v1\/?$/, "") ?? CopilotModels.DEFAULT_URL)
  // The GitHub OAuth token itself authorizes Copilot; V1 sent the stored `refresh`.
  const token = credential?.type === "oauth" ? credential.refresh : apiKey(model, credential)
  const auth = token === undefined ? Auth.none : Auth.bearer(token)
  const settings = model.api.type === "aisdk" ? model.api.settings : undefined
  const endpoint =
    settings?.endpoint ?? (model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic" ? "messages" : undefined)
  const headers = { ...CopilotModels.headers(), "Openai-Intent": "conversation-edits" }
  if (endpoint === "messages")
    return withDefaults(model, AnthropicMessages.route)
      .with({
        endpoint: { baseURL: `${base}/v1` },
        auth,
        headers: { ...headers, "anthropic-beta": "interleaved-thinking-2025-05-14" },
      })
      .model({ id: model.api.id })
  const responses =
    endpoint === "responses" || (endpoint !== "chat" && GitHubCopilot.shouldUseResponsesApi(model.api.id))
  // Responses runs stateless (store: false) with encrypted reasoning, as V1 did;
  // V1's Copilot chat model sent neither `store` nor a default effort.
  const route = responses
    ? GitHubCopilot.configure({ baseURL: base }).responses(model.api.id).route
    : OpenAIChat.route
  return withDefaults(model, route).with({ endpoint: { baseURL: base }, auth, headers }).model({ id: model.api.id })
}

const AZURE_SETTINGS = ["resourceName", "apiVersion", "useCompletionUrls", "useDeploymentBasedUrls"]

/**
 * Azure OpenAI: `{resource}.openai.azure.com/openai/v1` with `api-version`
 * (default `v1`), or deployment URLs when `useDeploymentBasedUrls` is set.
 * Auth is the `api-key` header; without a key it falls back to a Microsoft
 * Entra token, either a configured `Authorization` header or the Azure CLI's.
 */
const azure = (model: ModelV2.Info, credential?: Credential.Value) => {
  const resource = azureResource(model)
  const deployments = setting(model, "useDeploymentBasedUrls") === true
  const apiVersion = setting(model, "apiVersion")
  if (!model.api.url && !resource) return Effect.fail(unsupported(model))
  const base = model.api.url ?? `https://${resource!.trim()}.openai.azure.com/openai`
  const baseURL = deployments
    ? `${base.replace(/\/v1\/?$/, "")}/deployments/${model.api.id}`
    : model.api.url ?? `${base}/v1`
  const key = cloudKey(model, credential, ["AZURE_RESOURCE_NAME"], "AZURE_API_KEY")
  const configured = Object.keys(model.request.headers).some((name) => name.toLowerCase() === "authorization")
  const auth = key
    ? Auth.header("api-key", key)
    : configured
      ? Auth.none
      : Auth.effect(AzureEntra.token).bearer()
  const route = Azure.configure({
    baseURL,
    apiVersion: typeof apiVersion === "string" ? apiVersion : undefined,
    useCompletionUrls: setting(model, "useCompletionUrls") === true,
    auth,
  }).model(model.api.id).route
  return Effect.succeed(
    withDefaults(model, route, AZURE_SETTINGS).with({ endpoint: { baseURL }, auth }).model({ id: model.api.id }),
  )
}

/**
 * The API key for a cloud provider whose models.dev entry lists configuration
 * env vars beside the key. Integration env connections cannot tell them apart,
 * so a "key" equal to one of `settings` (a resource name, a project) is
 * configuration, and the provider's own key variable is read instead.
 */
const cloudKey = (
  model: ModelV2.Info,
  credential: Credential.Value | undefined,
  settings: ReadonlyArray<string>,
  keyEnv: string,
) => {
  const misread = credential?.type === "key" && settings.some((name) => process.env[name] === credential.key)
  const key = apiKey(model, misread ? undefined : credential)
  if (key) return key
  const env = process.env[keyEnv]
  return env ? Auth.value(env) : undefined
}

const setting = (model: ModelV2.Info, key: string) =>
  (model.api.type === "aisdk" ? model.api.settings?.[key] : undefined) ?? model.request.body[key]

const azureResource = (model: ModelV2.Info) => {
  const value = setting(model, "resourceName")
  if (typeof value === "string" && value.trim() !== "") return value
  return process.env.AZURE_RESOURCE_NAME
}

// models.dev lists Azure AI Foundry models (Claude, DeepSeek, Kimi) under the
// Azure provider with a `${AZURE_RESOURCE_NAME}` URL template.
const expandAzureTemplate = (model: ModelV2.Info) => {
  if (!model.api.url?.includes("${AZURE_RESOURCE_NAME}")) return model
  const resource = azureResource(model)
  if (!resource) return model
  return produce(model, (draft) => {
    draft.api.url = draft.api.url!.replaceAll("${AZURE_RESOURCE_NAME}", resource.trim())
    delete draft.request.body.resourceName
  })
}

const VERTEX_SETTINGS = ["project", "location", "fetch", "googleAuthOptions"]

const isVertex = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package.startsWith("@ai-sdk/google-vertex") ||
    (model.providerID === ProviderV2.ID.googleVertex && model.api.package === "@ai-sdk/openai-compatible"))

/**
 * Google Vertex AI: Gemini over `generateContent`, Claude over `rawPredict`,
 * and partner (MaaS) models over the OpenAI-compatible endpoint, all under
 * `/v1/projects/{project}/locations/{location}`. Auth is Application Default
 * Credentials, a configured `Authorization` header, or, for Gemini only, an
 * express-mode API key.
 */
const vertex = (model: ModelV2.Info, credential?: Credential.Value) => {
  const anthropic = model.api.type === "aisdk" && model.api.package === "@ai-sdk/google-vertex/anthropic"
  const project = vertexSetting(model, "project", [
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "GCLOUD_PROJECT",
  ])
  const location =
    vertexSetting(model, "location", ["GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION"]) ??
    (anthropic ? "global" : "us-central1")
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : // Continental multi-regions resolve only on the Regional Endpoint Platform domain.
        anthropic && (location === "eu" || location === "us")
        ? `aiplatform.${location}.rep.googleapis.com`
        : `${location}-aiplatform.googleapis.com`
  const url = model.api.url
    ?.replaceAll("${GOOGLE_VERTEX_PROJECT}", project ?? "${GOOGLE_VERTEX_PROJECT}")
    .replaceAll("${GOOGLE_VERTEX_LOCATION}", location)
    .replaceAll("${GOOGLE_VERTEX_ENDPOINT}", host)
  const key = cloudKey(
    model,
    credential,
    ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
    "GOOGLE_VERTEX_API_KEY",
  )
  const configured = Object.keys(model.request.headers).some((name) => name.toLowerCase() === "authorization")
  const bearer = configured ? Auth.none : Auth.effect(GoogleCloudAuth.token).bearer()
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai-compatible") {
    if (!url || url.includes("${")) return Effect.fail(unsupported(model))
    return Effect.succeed(
      withDefaults(model, OpenAICompatibleChat.route, VERTEX_SETTINGS)
        .with({ endpoint: { baseURL: url }, auth: bearer })
        .model({ id: model.api.id }),
    )
  }
  const publisher = anthropic ? "anthropic" : "google"
  // Express mode: a Vertex API key reaches Gemini without a project.
  const express = !anthropic && key !== undefined && !project && !url
  if (!url && !project && !express) return Effect.fail(unsupported(model))
  const baseURL = express
    ? "https://aiplatform.googleapis.com/v1/publishers/google"
    : (url ?? `https://${host}/v1/projects/${project}/locations/${location}/publishers/${publisher}`)
  const auth = !anthropic && key !== undefined ? Auth.header("x-goog-api-key", key) : bearer
  return Effect.succeed(
    withDefaults(model, anthropic ? AnthropicMessages.vertexRoute : Gemini.route, VERTEX_SETTINGS)
      .with({ endpoint: { baseURL }, auth })
      .model({ id: model.api.id.trim() }),
  )
}

const vertexSetting = (model: ModelV2.Info, key: string, env: ReadonlyArray<string>) => {
  const value = setting(model, key)
  if (typeof value === "string" && value !== "") return value
  return env.map((name) => process.env[name]).find((item) => item !== undefined && item !== "")
}

export const resolveWithInfo = (
  session: SessionSchema.Info,
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Resolved, UnsupportedApiError | VariantUnavailableError> =>
  withVariant(model, session.model?.variant).pipe(
    Effect.flatMap((info) => fromCatalogModel(info, credential).pipe(Effect.map((route) => ({ model: route, info })))),
  )

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  resolveWithInfo(session, model, credential).pipe(Effect.map((resolved) => resolved.model))

export const supported = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return false
  if (model.providerID === ProviderV2.ID.githubCopilot) return true
  if (model.api.package === "@ai-sdk/azure") return model.api.url !== undefined || azureResource(model) !== undefined
  if (isVertex(model)) return true
  if (
    model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    model.api.package === "@ai-sdk/google"
  ) {
    return true
  }
  return model.api.url !== undefined || COMPATIBLE_BASE_URLS[model.api.package] !== undefined
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolveWithInfo(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
      resolveSmall: Effect.fn("SessionRunnerModel.resolveSmall")(function* (session) {
        return yield* Effect.gen(function* () {
          const providerID = session.model?.providerID ?? (yield* catalog.model.default())?.providerID
          if (!providerID) return undefined
          const selected = yield* catalog.model.small(providerID)
          if (!selected || !supported(selected)) return undefined
          const provider = yield* catalog.provider.get(selected.providerID)
          const connection = yield* integrations.connection.active(
            provider?.integrationID ?? Integration.ID.make(selected.providerID),
          )
          return yield* fromCatalogModel(
            selected,
            connection ? yield* integrations.connection.resolve(connection) : undefined,
          )
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node] })
