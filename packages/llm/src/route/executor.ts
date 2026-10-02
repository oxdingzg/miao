import { Cause, Context, Effect, Layer, Option, Random } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "../schema"
import { isContextOverflow } from "../provider-error"
import {
  captureBody,
  normalizedHeaders,
  redactHeaders,
  redactUrl,
  requestBodyText,
  requestDetails,
  requestId,
  responseDetails,
  type CapturedBody,
} from "./http-capture"
import { ProviderWireArchive } from "./archive"

export interface Interface {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/LLM/RequestExecutor") {}

const MAX_RETRIES = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
const MIN_RETRY_AFTER_MS = 250

const retryableStatus = (status: number) => status === 429 || status === 503 || status === 504 || status === 529

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const providerMessage = (status: number, body: CapturedBody) => {
  if (body.body && body.body.length <= 500) return `Provider request failed with HTTP ${status}: ${body.body}`
  return `Provider request failed with HTTP ${status}`
}

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly redactedNames: ReadonlyArray<string | RegExp>
  readonly body: CapturedBody
  readonly requestId?: string | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request, input.redactedNames),
    response: responseDetails(input.response, input.redactedNames),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (/content[-_\s]?policy|content_filter|safety/i.test(body)) {
    return new ContentPolicyReason({ message: input.message, http: input.http })
  }
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  ) {
    return new InvalidRequestReason({
      message: input.message,
      classification: isContextOverflow(body) ? "context-overflow" : undefined,
      http: input.http,
    })
  }
  if (input.status >= 500 || retryableStatus(input.status)) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

/**
 * Archive lines for one HTTP attempt, or nothing when no exchange is being
 * traced. Built per attempt rather than per exchange so that the attempts the
 * retry loop below makes are each recorded, not collapsed into the last one.
 */
const tracerFor = (input: {
  readonly exchange: ProviderWireArchive.Exchange | undefined
  readonly archive: ProviderWireArchive.Interface | undefined
  readonly request: HttpClientRequest.HttpClientRequest
  readonly redactedNames: ReadonlyArray<string | RegExp>
}) => {
  if (input.exchange === undefined || input.archive === undefined) return undefined
  const exchange = input.exchange
  const archive = input.archive
  const request = input.request
  const base = { exchange: exchange.id, route: exchange.route, attempt: ProviderWireArchive.attemptID() }
  return {
    request: () =>
      archive.record({
        ...base,
        at: Date.now(),
        kind: "request",
        method: request.method,
        url: redactUrl(request.url),
        headers: redactHeaders(request.headers, input.redactedNames),
        ...captureBody(requestBodyText(request), request, ProviderWireArchive.MAX_CAPTURE_BYTES),
      }),
    response: (response: HttpClientResponse.HttpClientResponse, body: CapturedBody) =>
      archive.record({
        ...base,
        at: Date.now(),
        kind: "response",
        status: response.status,
        headers: redactHeaders(response.headers, input.redactedNames),
        requestID: requestId(normalizedHeaders(response.headers)),
        ...body,
      }),
    error: (error: LLMError) =>
      archive.record({ ...base, at: Date.now(), kind: "error", tag: error.reason._tag, message: error.reason.message }),
  }
}

const statusError =
  (
    request: HttpClientRequest.HttpClientRequest,
    redactedNames: ReadonlyArray<string | RegExp>,
    trace: ReturnType<typeof tracerFor>,
  ) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status < 400) {
        if (trace !== undefined) yield* trace.response(response, {})
        return response
      }
      const body = yield* response.text.pipe(Effect.catch(() => Effect.void))
      const headers = normalizedHeaders(response.headers)
      const retryAfter = retryAfterMs(headers)
      const rateLimit = rateLimitDetails(headers, retryAfter)
      const details = captureBody(body, request)
      if (trace !== undefined) yield* trace.response(response, details)
      return yield* new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: statusReason({
          status: response.status,
          message: providerMessage(response.status, details),
          retryAfterMs: retryAfter,
          rateLimit,
          http: responseHttp({
            request,
            response,
            redactedNames,
            body: details,
            requestId: requestId(headers),
            rateLimit,
          }),
        }),
      })
    })

// Effect's fetch client reports a client-side reject as
// `TransportError({ request, cause })` and leaves `description` unset, so the
// underlying failure only exists on `cause`. Flatten it into one readable
// fragment: the error message, its errno-style code, and the wrapped cause that
// undici attaches (`TypeError: fetch failed` -> `Error: connect ECONNRESET`).
export const causeDetail = (cause: unknown): string | undefined => {
  if (cause === undefined || cause === null) return undefined
  if (!(cause instanceof Error)) return String(cause)
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined
  const wrapped = cause.cause
  const wrappedMessage = wrapped instanceof Error ? wrapped.message : typeof wrapped === "string" ? wrapped : undefined
  const detail = [cause.message, code, wrappedMessage]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" / ")
  return detail.length > 0 ? detail : undefined
}

const toHttpError = (redactedNames: ReadonlyArray<string | RegExp>) => (error: unknown) => {
  const transportError = (input: {
    readonly message: string
    readonly kind?: string | undefined
    readonly request?: HttpClientRequest.HttpClientRequest | undefined
  }) =>
    new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new TransportReason({
        message: input.message,
        kind: input.kind,
        url: input.request ? redactUrl(input.request.url) : undefined,
        http: input.request ? new HttpContext({ request: requestDetails(input.request, redactedNames) }) : undefined,
      }),
    })

  if (Cause.isTimeoutError(error)) {
    return transportError({ message: error.message, kind: "Timeout" })
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return transportError({ message: `HTTP transport failed: ${causeDetail(error) ?? "unknown error"}` })
  }
  const request = "request" in error ? error.request : undefined
  if (error.reason._tag === "TransportError") {
    const detail = [error.reason.description, causeDetail(error.reason.cause)]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ")
    return transportError({
      // Prefer the concrete cause; Effect's own message carries only the method
      // and URL, which is still far more useful than a bare constant.
      message: detail.length > 0 ? detail : error.reason.message,
      kind: error.reason._tag,
      request,
    })
  }
  return transportError({
    message: `HTTP transport failed: ${error.reason._tag}`,
    kind: error.reason._tag,
    request,
  })
}

const retryDelay = (error: LLMError, attempt: number) => {
  // A provider's retry hint is honoured but floored: `Retry-After: 0` from an
  // overloaded backend would otherwise retry back to back with no pause at all.
  if (error.retryAfterMs !== undefined)
    return Effect.succeed(Math.min(Math.max(error.retryAfterMs, MIN_RETRY_AFTER_MS), MAX_DELAY_MS))
  return Random.nextBetween(
    Math.min(BASE_DELAY_MS * 2 ** attempt * 0.8, MAX_DELAY_MS),
    Math.min(BASE_DELAY_MS * 2 ** attempt * 1.2, MAX_DELAY_MS),
  ).pipe(Effect.map((delay) => Math.round(delay)))
}

const retryStatusFailures = <A, R>(
  effect: Effect.Effect<A, LLMError, R>,
  retries = MAX_RETRIES,
  attempt = 0,
): Effect.Effect<A, LLMError, R> =>
  Effect.catchTag(effect, "LLM.Error", (error): Effect.Effect<A, LLMError, R> => {
    if (!error.retryable || retries <= 0) return Effect.fail(error)
    return retryDelay(error, attempt).pipe(
      Effect.flatMap((delay) => Effect.sleep(delay)),
      Effect.flatMap(() => retryStatusFailures(effect, retries - 1, attempt + 1)),
    )
  })

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const executeOnce = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const redactedNames = yield* Headers.CurrentRedactedNames
        const trace = tracerFor({
          exchange: yield* ProviderWireArchive.CurrentExchange,
          archive: Option.getOrUndefined(yield* Effect.serviceOption(ProviderWireArchive.Service)),
          request,
          redactedNames,
        })
        if (trace !== undefined) yield* trace.request()
        return yield* http
          .execute(request)
          .pipe(
            Effect.mapError(toHttpError(redactedNames)),
            Effect.flatMap(statusError(request, redactedNames, trace)),
            Effect.tapError((error) => (trace === undefined ? Effect.void : trace.error(error))),
          )
      })
    return Service.of({
      execute: (request) => retryStatusFailures(executeOnce(request)),
    })
  }),
)

export const fetchLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

export * as RequestExecutor from "./executor"
