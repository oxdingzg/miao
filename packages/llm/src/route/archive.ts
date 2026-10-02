export * as ProviderWireArchive from "./archive"

import { Context, Effect, Layer } from "effect"

/**
 * Append-only record of what actually crossed the wire to a provider.
 *
 * The Session event stream already persists the decoded turn: text, reasoning,
 * tool calls, usage, and the retry causes. What it cannot show is the request
 * the provider was sent or the raw frames it answered with, and those are the
 * only witnesses for a cache miss that should have been a hit, a body the
 * provider rejected for a reason it does not name, and a stream the parser
 * mis-reads.
 *
 * Off unless the host provides a layer. Options in the four pieces:
 *
 * - The executor records one request, response, or error line per HTTP attempt,
 *   including each attempt its own retry loop makes, because a throttle that
 *   silently retried three times is exactly the incident this exists for.
 * - The transport records one line per decoded protocol frame, tagged with the
 *   same `exchange`.
 * - A reader groups lines by `exchange` and orders attempts by `at`.
 * - Payloads are redacted by the same rule the error path uses, so nothing
 *   reaches the archive that a typed `LLMError` would have withheld.
 */

/**
 * The exchange a provider call belongs to. The transport knows the route and
 * the executor does not, so both travel together: the transport opens the
 * exchange, and every line one HTTP attempt produces is tagged from it.
 */
export interface Exchange {
  readonly id: string
  readonly route: string
}

export const exchange = (route: string): Exchange => ({ id: crypto.randomUUID(), route })

/** Where one `Transport.frames` call began: one provider exchange, however many HTTP attempts it took. */
export const CurrentExchange = Context.Reference<Exchange | undefined>(
  "@miao/LLM/ProviderWireArchive/CurrentExchange",
  { defaultValue: () => undefined },
)

export const attemptID = () => crypto.randomUUID()

/**
 * Ceiling on a captured payload. Generous on purpose: the archive is opt-in and
 * exists to reconstruct a request exactly, so it is bounded only against a
 * runaway body, not tuned for size.
 */
export const MAX_CAPTURE_BYTES = 1_048_576

interface Base {
  readonly exchange: string
  readonly at: number
  readonly route: string
}

export interface RequestLine extends Base {
  readonly kind: "request"
  /** Distinguishes the attempts of one exchange; every exchange has at least one. */
  readonly attempt: string
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body?: string
  readonly bodyTruncated?: boolean
}

export interface ResponseLine extends Base {
  readonly kind: "response"
  readonly attempt: string
  readonly status: number
  readonly headers: Record<string, string>
  readonly requestID?: string
  readonly body?: string
  readonly bodyTruncated?: boolean
}

export interface FrameLine extends Base {
  readonly kind: "frame"
  readonly text: string
  readonly truncated?: boolean
}

export interface ErrorLine extends Base {
  readonly kind: "error"
  readonly attempt: string
  readonly tag: string
  readonly message: string
}

/** One line of the archive. Every line carries the exchange it belongs to. */
export type Line = RequestLine | ResponseLine | FrameLine | ErrorLine

export interface Interface {
  readonly record: (line: Line) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@miao/LLM/ProviderWireArchive") {}

/** A collecting layer for tests; the host supplies the writing one. */
export const layerOf = (record: Interface["record"]): Layer.Layer<Service> => Layer.succeed(Service, Service.of({ record }))

/** A frame as archive text. Frames are protocol payloads, so a non-string one is its JSON. */
export const frameText = (frame: unknown): string => {
  if (typeof frame === "string") return frame
  const json = JSON.stringify(frame)
  return json === undefined ? String(frame) : json
}

export const truncate = (text: string) =>
  text.length <= MAX_CAPTURE_BYTES ? { text } : { text: text.slice(0, MAX_CAPTURE_BYTES), truncated: true }
