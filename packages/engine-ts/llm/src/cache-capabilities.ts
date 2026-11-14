import { Effect, Schema } from "effect"
import type { LLMRequest } from "./schema"
import { Endpoint } from "./route/endpoint"
import { invalidRequest, validateWith } from "./protocols/shared"

const Options = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["implicit", "explicit"])),
  ttl: Schema.optional(Schema.Literal("30m")),
  prewarm: Schema.optional(Schema.Boolean),
})
const Retention = Schema.Literals(["in_memory", "24h"])

/** Capability assertions belong to a selected deployment/model, not merely
 * to a protocol family. Render the exact validated body before transport. */
export const validateCacheCapability = Effect.fn("LLM.validateCacheCapability")(function* (
  request: LLMRequest,
  body: unknown,
) {
  const capability = request.model.compatibility?.responsesCache
  if (!capability) return
  const route = request.model.route
  if (
    route.protocol !== "openai-responses" ||
    request.model.id !== capability.model ||
    !URL.canParse(capability.endpoint)
  )
    return yield* invalidRequest("Responses cache capability does not match the selected deployment/model")
  const actual = Endpoint.render(route.endpoint, { request, body })
  for (const [key, value] of Object.entries(request.http?.query ?? {})) actual.searchParams.set(key, value)
  if (actual.href !== new URL(capability.endpoint).href)
    return yield* invalidRequest("Responses cache capability does not match the selected endpoint")
  const overrides = request.http?.body
  if (overrides?.model !== undefined && overrides.model !== capability.model)
    return yield* invalidRequest("Responses cache capability cannot be reused by a raw model override")
  if (capability.profile === "breakpoints" && overrides?.input !== undefined)
    return yield* invalidRequest("Bound breakpoint controls require semantic messages, not raw input overrides")
  if (
    overrides &&
    (Object.hasOwn(overrides, "prompt_cache_options") || Object.hasOwn(overrides, "prompt_cache_retention"))
  )
    return yield* invalidRequest("Bound cache controls must use semantic provider options, not raw HTTP overrides")
})

/** Protocol lowering consumes only the validated semantic capability. */
export const responsesCachePolicy = Effect.fn("LLM.responsesCachePolicy")(function* (request: LLMRequest) {
  const capability = request.model.compatibility?.responsesCache
  const raw = request.providerOptions?.openai?.promptCacheOptions
  const retention = request.providerOptions?.openai?.promptCacheRetention
  if (raw !== undefined && capability?.profile !== "breakpoints")
    return yield* invalidRequest("Responses cache options require an explicit breakpoint-capable deployment")
  if (retention !== undefined && capability?.profile !== "legacy")
    return yield* invalidRequest("Responses legacy cache retention requires a matching legacy deployment")
  if (capability?.profile !== "breakpoints")
    return {
      retention:
        retention === undefined ? undefined : yield* validateWith(Schema.decodeUnknownEffect(Retention))(retention),
    }
  const options = raw === undefined ? {} : yield* validateWith(Schema.decodeUnknownEffect(Options))(raw)
  const disabled = request.cache === "none"
  const ttl = typeof request.cache === "object" ? request.cache.ttlSeconds : undefined
  if (ttl !== undefined && ttl !== 1800)
    return yield* invalidRequest("This Responses cache capability supports only a 30 minute TTL")
  if (disabled && (options.mode === "implicit" || options.prewarm === true))
    return yield* invalidRequest("Disabled caching cannot enable implicit writes or prewarming")
  const system =
    !disabled && request.system.length > 0 && (typeof request.cache !== "object" || request.cache.system !== false)
  const mode = disabled ? "explicit" : (options.mode ?? "implicit")
  if (mode === "explicit" && !disabled && !system)
    return yield* invalidRequest("Explicit Responses caching needs a stable system breakpoint")
  return {
    system,
    options: {
      mode,
      ...(options.ttl !== undefined || ttl === 1800 ? { ttl: "30m" as const } : {}),
      ...(options.prewarm !== undefined ? { prewarm: options.prewarm } : {}),
    },
  }
})
