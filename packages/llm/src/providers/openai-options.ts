import type { ProviderOptions, ReasoningEffort, TextVerbosity } from "../schema"
import { mergeProviderOptions } from "../schema"
import type { OpenAIResponseIncludable, OpenAIServiceTier } from "../protocols/utils/openai-options"

export type { OpenAIResponseIncludable, OpenAIServiceTier } from "../protocols/utils/openai-options"

export interface OpenAIOptionsInput {
  readonly [key: string]: unknown
  readonly store?: boolean
  readonly promptCacheKey?: string
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningSummary?: "auto"
  // OpenAI Responses `include` wire field. Mirrors the official SDK's
  // `ResponseIncludable[]` union exactly so AI SDK callers and direct
  // native-SDK callers share one shape and no translation is required.
  readonly include?: ReadonlyArray<OpenAIResponseIncludable>
  readonly textVerbosity?: TextVerbosity
  readonly serviceTier?: OpenAIServiceTier
}

export type OpenAIProviderOptionsInput = ProviderOptions & {
  readonly openai?: OpenAIOptionsInput
}

const definedEntries = (input: Record<string, unknown>) =>
  Object.entries(input).filter((entry) => entry[1] !== undefined)

const openAIProviderOptions = (options: OpenAIOptionsInput | undefined): ProviderOptions | undefined => {
  const openai = Object.fromEntries(
    definedEntries({
      store: options?.store,
      promptCacheKey: options?.promptCacheKey,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      include: options?.include,
      textVerbosity: options?.textVerbosity,
      serviceTier: options?.serviceTier,
    }),
  )
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

// GPT-5 and later are reasoning models, except the chat/pro variants that
// dropped the reasoning controls. Only the model id is available at this layer,
// so match the family prefix instead of one version: keying off a single version
// silently drops every later model to no reasoning options at all.
const isReasoningModel = (id: string) => {
  const match = id.match(/^gpt-(\d+)/)
  if (!match) return false
  return Number(match[1]) >= 5 && !id.includes("-chat") && !id.includes("-pro")
}

const hasVersion = (id: string) => /^gpt-\d+\./.test(id)

export const gpt5DefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined => {
  const id = modelID.toLowerCase()
  if (!isReasoningModel(id)) return undefined
  return openAIProviderOptions({
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    // Reasoning models are configured stateless (`store: false`) by
    // `openAIDefaultOptions` below, so the only way a follow-up turn can
    // carry reasoning state is via the encrypted reasoning include. Without
    // this, callers using the default model facade get reasoning summaries
    // they cannot replay statelessly.
    include: ["reasoning.encrypted_content"],
    textVerbosity:
      options.textVerbosity === true && hasVersion(id) && !id.includes("codex") && !id.includes("-chat")
        ? "low"
        : undefined,
  })
}

export const openAIDefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined =>
  mergeProviderOptions(openAIProviderOptions({ store: false }), gpt5DefaultOptions(modelID, options))

export const withOpenAIOptions = <Options extends { readonly providerOptions?: OpenAIProviderOptionsInput }>(
  modelID: string,
  options: Options,
  defaults: { readonly textVerbosity?: boolean } = {},
): Omit<Options, "providerOptions"> & { readonly providerOptions?: ProviderOptions } => {
  return {
    ...options,
    providerOptions: mergeProviderOptions(openAIDefaultOptions(modelID, defaults), options.providerOptions),
  }
}

export * as OpenAIProviderOptions from "./openai-options"
