import { EngineHttpClient, type EngineEvent } from "@miao/client/engine"
import {
  catalogToSummaries,
  snapshotToState,
  type EngineCatalogRow,
  type EngineSessionState,
  type EngineSessionSummary,
  type EngineSnapshot,
} from "./engine-session"

/**
 * What the reader needs from a transport. `EngineHttpClient` provides it; a test
 * can provide the same shape without a socket, because the HTTP behaviour itself
 * is covered where the transport lives (`packages/client`).
 */
export type EngineTransport = {
  request(method: string, params?: unknown): Promise<unknown>
  subscribe(session: string, after?: number): Promise<void>
  onEvent(handler: (event: EngineEvent) => void): void
  close(): Promise<void>
}

/**
 * The read side of one window's attachment to a local engine: catalog, one
 * Session's header, and its committed events. Writes stay out until a caller
 * needs them, so nothing here can start model work by accident.
 */
export function createEngineReader(input: {
  url: string
  token: string
  timeoutMs?: number
  transport?: EngineTransport
}) {
  const transport = input.transport ?? new EngineHttpClient(input)
  const listeners = new Map<string, Set<(event: EngineEvent) => void>>()
  const forwarded = new Set<string>()

  transport.onEvent((event) => {
    for (const listener of listeners.get(event.session_id) ?? []) listener(event)
  })

  const sessions = async (options?: { includeArchived?: boolean }) =>
    catalogToSummaries((await transport.request("session_catalog")) as EngineCatalogRow[], options)

  const snapshot = async (sessionID: string) =>
    snapshotToState((await transport.request("snapshot", { session_id: sessionID })) as EngineSnapshot)

  return {
    sessions,
    snapshot,
    /** Attach to one Session's committed events, replaying from `after`. */
    async subscribe(sessionID: string, handler: (event: EngineEvent) => void, after = 0) {
      const set = listeners.get(sessionID) ?? new Set()
      listeners.set(sessionID, set)
      set.add(handler)
      // One transport stream per Session; later subscribers join the fan-out.
      if (!forwarded.has(sessionID)) {
        forwarded.add(sessionID)
        await transport.subscribe(sessionID, after)
      }
      return () => set.delete(handler)
    },
    async close() {
      listeners.clear()
      forwarded.clear()
      await transport.close()
    },
  }
}

export type EngineReader = ReturnType<typeof createEngineReader>

export type { EngineSessionState, EngineSessionSummary }
