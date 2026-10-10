import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

/**
 * Client-side keep-alive latch for the shared HTTP transport.
 *
 * Bun reuses pooled keep-alive sockets even after the peer (a provider, a proxy,
 * Cloudflare) has closed them; the next request then dies with
 * `The socket connection was closed unexpectedly` / ECONNRESET. Once a reset is
 * observed, stop reusing sockets — Bun opens a fresh connection per request when
 * `keepalive: false` — until the window elapses or a request succeeds again.
 *
 * The latch is process-global and best-effort: under a burst of resets it trades
 * a little latency (a new handshake per request) for recovery, and it never
 * affects correctness.
 */
export const STALE_WINDOW_MS = 60_000

let staleUntil = 0

/** Stop reusing pooled sockets for the window starting now. */
export const markStale = (now = Date.now()) => {
  staleUntil = now + STALE_WINDOW_MS
}

/** A request reached the provider, so pooling is safe again. */
export const clearStale = () => {
  staleUntil = 0
}

export const isStale = (now = Date.now()) => now < staleUntil

const staleGuarded = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
  isStale() ? globalThis.fetch(input, { ...init, keepalive: false }) : globalThis.fetch(input, init)

/** `globalThis.fetch` that opens a fresh socket while the latch is set. */
export const guardedFetch: typeof globalThis.fetch = Object.assign(staleGuarded, {
  preconnect: globalThis.fetch.preconnect,
})

/** The HTTP client whose fetch stops reusing stale sockets after a reset. */
export const httpClientLayer = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, guardedFetch)))
