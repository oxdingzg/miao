/**
 * Per-attempt liveness signals from a provider transport.
 *
 * A stream can be silently dead, slow before its first token, or alive but
 * blocked on a large prompt. The session runner distinguishes those cases by
 * watching response headers, wire bytes (keep-alives included), and canonical
 * events separately; the transport reports the first two here. Callbacks are
 * synchronous because they run inside the transport's data path.
 */
export interface StreamActivity {
  /** Response headers arrived; the request is no longer waiting to connect. */
  readonly headers: () => void
  /** Response body bytes arrived, including protocol keep-alives. */
  readonly bytes: (count: number) => void
  /** Encoded request body size, used to widen the first-byte deadline. */
  readonly requestBytes: (count: number) => void
}

export * as StreamActivity from "./activity"
