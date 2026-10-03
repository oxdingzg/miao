export * as CopilotModels from "./models"

import { shouldUseResponsesApi } from "@miao/llm/providers/github-copilot"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { InstallationVersion } from "../installation/version"
import type { ModelV2Info } from "@miao/sdk/v2/types"

/** Copilot API version the V1 plugin pinned; Copilot rejects unknown versions. */
export const API_VERSION = "2026-06-01"
export const DEFAULT_URL = "https://api.githubcopilot.com"
/** Utility models GitHub serves for titles without listing them in the picker. */
export const UTILITY_MODELS = ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]

export type Endpoint = "chat" | "responses" | "messages"

export const normalizeDomain = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "")

/** Copilot API base for github.com or a GitHub Enterprise (data residency) domain. */
export const baseURL = (enterpriseUrl?: string) =>
  enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : DEFAULT_URL

export const headers = () => ({
  "User-Agent": `miao/${InstallationVersion}`,
  "X-GitHub-Api-Version": API_VERSION,
})

const Item = Schema.Struct({
  model_picker_enabled: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  // every version looks like: `{model.id}-YYYY-MM-DD`
  version: Schema.String,
  supported_endpoints: Schema.optional(Schema.Array(Schema.String)),
  policy: Schema.optional(Schema.Struct({ state: Schema.optional(Schema.String) })),
  billing: Schema.optional(
    Schema.Struct({
      token_prices: Schema.optional(
        Schema.Struct({
          batch_size: Schema.Number,
          default: Schema.Struct({
            cache_price: Schema.Number,
            input_price: Schema.Number,
            output_price: Schema.Number,
          }),
        }),
      ),
    }),
  ),
  capabilities: Schema.Struct({
    family: Schema.String,
    limits: Schema.optional(
      Schema.Struct({
        max_context_window_tokens: Schema.optional(Schema.Number),
        max_output_tokens: Schema.optional(Schema.Number),
        max_prompt_tokens: Schema.optional(Schema.Number),
        vision: Schema.optional(
          Schema.Struct({
            supported_media_types: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
    supports: Schema.Struct({
      adaptive_thinking: Schema.optional(Schema.Boolean),
      max_thinking_budget: Schema.optional(Schema.Number),
      reasoning_effort: Schema.optional(Schema.Array(Schema.String)),
      tool_calls: Schema.optional(Schema.Boolean),
      vision: Schema.optional(Schema.Boolean),
    }),
  }),
})
type Item = typeof Item.Type

const decodeItem = Schema.decodeUnknownOption(Item)
const List = Schema.Struct({ data: Schema.Array(Schema.Unknown) })

export type Remote = {
  readonly id: string
  readonly name: string
  readonly family: string
  readonly picker: boolean
  readonly endpoint?: Endpoint
  readonly released: number
  readonly limit: { readonly context: number; readonly input: number; readonly output: number }
  readonly tools: boolean
  readonly input: ReadonlyArray<string>
  readonly efforts: ReadonlyArray<string>
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number }
}

/**
 * The models one Copilot account may call, from `{base}/models`, or
 * `undefined` when the API could not say. Callers keep the catalog as-is on
 * `undefined`: an unreachable API must not hide models the account can use.
 */
export const list = (input: { readonly baseURL: string; readonly token: string; readonly http: HttpClient.HttpClient }) =>
  HttpClientRequest.get(`${input.baseURL}/models`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.setHeaders(headers()),
    input.http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(List)),
    Effect.map((body) =>
      body.data.flatMap((raw) => {
        const item = Option.getOrUndefined(decodeItem(raw))
        return item && usable(item) ? [remote(item)] : []
      }),
    ),
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  )

/** Writes one remote Copilot model onto its catalog entry, keeping configured names. */
export const apply = (model: ModelV2Info, item: Remote, base: string, existing: boolean) => {
  const messages = item.endpoint === "messages"
  model.api = {
    id: item.id,
    type: "aisdk",
    package: messages ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
    url: messages ? `${base}/v1` : base,
    settings: item.endpoint ? { endpoint: item.endpoint } : {},
  }
  if (!existing) {
    model.name = item.name
    model.family = item.family
  }
  model.status = "active"
  model.enabled = item.picker
  model.limit = { ...item.limit }
  model.capabilities = { tools: item.tools, input: [...item.input], output: ["text"] }
  model.cost = [{ input: item.cost.input, output: item.cost.output, cache: { read: item.cost.cacheRead, write: 0 } }]
  if (item.released > 0) model.time = { released: item.released }
  model.variants = variants(item)
}

function usable(item: Item) {
  return (
    item.policy?.state !== "disabled" &&
    item.capabilities.limits?.max_output_tokens !== undefined &&
    item.capabilities.limits.max_prompt_tokens !== undefined &&
    item.capabilities.supports.tool_calls !== undefined
  )
}

function remote(item: Item): Remote {
  const limits = item.capabilities.limits!
  const supports = item.capabilities.supports
  const media = limits.vision?.supported_media_types ?? []
  const image = (supports.vision ?? false) || media.some((type) => type.startsWith("image/"))
  const pdf = (supports.vision ?? false) && media.includes("application/pdf")
  const endpoints = item.supported_endpoints ?? []
  const prices = item.billing?.token_prices
  // Copilot prices are AIC per billing batch; the catalog stores USD per million tokens.
  const usdPerMillion = prices && prices.batch_size > 0 ? 10_000 / prices.batch_size : 0
  const released = Date.parse(
    item.version.startsWith(`${item.id}-`) ? item.version.slice(item.id.length + 1) : item.version,
  )
  return {
    id: item.id,
    name: item.name,
    family: item.capabilities.family,
    picker: item.model_picker_enabled,
    endpoint: endpoints.includes("/v1/messages")
      ? "messages"
      : endpoints.includes("/responses")
        ? "responses"
        : endpoints.includes("/chat/completions")
          ? "chat"
          : undefined,
    released: Number.isNaN(released) ? 0 : released,
    limit: {
      context: limits.max_context_window_tokens ?? limits.max_prompt_tokens!,
      input: limits.max_prompt_tokens!,
      output: limits.max_output_tokens!,
    },
    tools: supports.tool_calls!,
    input: ["text", ...(image ? ["image"] : []), ...(pdf ? ["pdf"] : [])],
    efforts: supports.reasoning_effort ?? [],
    cost: {
      input: (prices?.default.input_price ?? 0) * usdPerMillion,
      output: (prices?.default.output_price ?? 0) * usdPerMillion,
      cacheRead: (prices?.default.cache_price ?? 0) * usdPerMillion,
    },
  }
}

// Variant bodies are wire-level overlays. Anthropic thinking cannot be
// overlaid (the Messages route owns `thinking`), so the /v1/messages models
// get no effort variants here.
function variants(item: Remote): ModelV2Info["variants"] {
  if (item.endpoint === "messages") return []
  return item.efforts.map((effort) => ({
    id: effort,
    headers: {},
    body:
      (item.endpoint ?? (shouldUseResponsesApi(item.id) ? "responses" : "chat")) === "responses"
        ? { reasoning: { effort, summary: "auto" }, include: ["reasoning.encrypted_content"] }
        : { reasoning_effort: effort },
  }))
}
