export * as TencentTokenPlan from "./tencent-token-plan"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

/**
 * The Token Plan gateway publishes the model IDs one API key may call at
 * `{api}/models`. the catalog describes the plan from the outside, so its
 * entries can name models the key is not scoped for — Hy3 answers 403002
 * "not authorized" — and only this per-key list tells the two apart.
 */
export const API = "https://api.lkeap.cloud.tencent.com/plan/v3"

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })
const TIMEOUT = "5 seconds"
const AUTHORIZED_TTL = 10 * 60 * 1000
/** Retry a failed lookup soon, but not on every reload while the gateway is down. */
const UNAUTHORIZED_TTL = 30 * 1000

// Shared process-wide so the V1 provider list and the V2 catalog make one call.
const calls = new Map<string, { readonly expires: number; readonly models: ReadonlySet<string> | undefined }>()

/**
 * The model IDs `key` may call, or `undefined` when the gateway could not say.
 * Callers read `undefined` as "no information" and keep every model: an
 * unreachable gateway must not hide a model the key can use.
 */
export const authorizedModels = (input: {
  readonly baseURL: string
  readonly key: string
  readonly http: HttpClient.HttpClient
}) =>
  Effect.gen(function* () {
    const cacheKey = `${input.baseURL}\n${input.key}`
    const cached = calls.get(cacheKey)
    if (cached !== undefined && cached.expires > Date.now()) return cached.models
    const answer = yield* HttpClientRequest.get(`${input.baseURL}/models`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(input.key),
      input.http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
      Effect.map((body) => new Set(body.data.map((model) => model.id))),
      Effect.timeout(TIMEOUT),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    // An empty list is an answer we cannot act on, not a key with no models.
    const models = answer === undefined || answer.size === 0 ? undefined : answer
    calls.set(cacheKey, { expires: Date.now() + (models === undefined ? UNAUTHORIZED_TTL : AUTHORIZED_TTL), models })
    return models
  })
