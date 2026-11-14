import { Headers, type HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { HttpRequestDetails, HttpResponseDetails } from "../schema"

/**
 * Redaction and summarisation shared by the transport error path and the
 * provider wire archive.
 *
 * One source of truth for what counts as a secret matters more here than
 * anywhere else in the package: the error path puts a request/response into a
 * typed `LLMError`, and the archive writes one to disk, and a rule that held in
 * one but not the other would leak through whichever was weaker.
 */

export const BODY_LIMIT = 16_384
export const REDACTED = "<redacted>"

// `SENSITIVE_NAME` is used as both a substring matcher (for free-form header
// names like `Authorization` / `X-API-Key`) and as the body-field alternation
// list. `SHORT_QUERY_NAME` covers anchored short keys like `?key=…` / `?sig=…`
// that are too generic to redact substring-style without false positives.
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

export const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)

const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

export const redactHeaders = (headers: Headers.Headers, redactedNames: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

export const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

export const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

export const requestId = (headers: Record<string, string>) => {
  return (
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }

  Object.entries(request.headers).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) add(bearer)
  })

  if (!URL.canParse(request.url)) return values
  new URL(request.url).searchParams.forEach((value, key) => {
    if (isSensitiveQueryName(key)) add(value)
  })
  return values
}

// Two passes: structural (redact `"name": "value"` and `name=value` patterns
// for any field name that looks sensitive) plus literal (replace any actual
// secret values we sent in the request, in case the response echoes one back).
export const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

/** A captured body and whether it was shortened to fit, absent when there was none. */
export type CapturedBody = {
  readonly body?: string
  readonly bodyTruncated?: boolean
}

export const captureBody = (
  body: string | void,
  request: HttpClientRequest.HttpClientRequest,
  limit = BODY_LIMIT,
): CapturedBody => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  if (redacted.length <= limit) return { body: redacted }
  return { body: redacted.slice(0, limit), bodyTruncated: true }
}

/**
 * The JSON text a request is about to send, absent when the transport built a
 * body this cannot read (a stream, a form, or provider-native bytes).
 *
 * Every route in this package lowers its body through `ProviderShared.jsonPost`,
 * so a routed request is a `Uint8Array`; anything else is recorded without a body
 * rather than guessed at.
 */
export const requestBodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  if (request.body._tag !== "Uint8Array") return undefined
  return new TextDecoder().decode(request.body.body)
}

export const requestDetails = (
  request: HttpClientRequest.HttpClientRequest,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers, redactedNames),
  })

export const responseDetails = (
  response: HttpClientResponse.HttpClientResponse,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpResponseDetails({
    status: response.status,
    headers: redactHeaders(response.headers, redactedNames),
  })

export * as HttpCapture from "./http-capture"
