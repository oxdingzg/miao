import type { Client, Event } from "./types"

export type EventStream = {
  /** Resolves once the first subscription is live; events after it are delivered in order. */
  readonly connected: Promise<void>
}

/**
 * Follows the server's V2 event stream for the life of the connection and hands
 * each event to `handle` one at a time, so notifications reach the client in
 * the order the server published them. A dropped stream reconnects after a
 * second; work that must not hang on a lost event (turn completion) has its own
 * fallback.
 */
export function follow(input: {
  readonly client: Client
  readonly signal: AbortSignal
  readonly handle: (event: Event) => Promise<void>
  readonly log: (message: string) => void
}): EventStream {
  const connected = Promise.withResolvers<void>()

  const consume = async () => {
    for await (const event of input.client.events.subscribe({ signal: input.signal })) {
      if (event.type === "server.connected") {
        connected.resolve()
        continue
      }
      await input.handle(event).catch((error: unknown) => input.log(`acp: handling ${event.type}: ${String(error)}`))
    }
  }

  void (async () => {
    while (!input.signal.aborted) {
      await consume().catch((error: unknown) => {
        if (!input.signal.aborted) input.log(`acp: event stream: ${String(error)}`)
      })
      if (!input.signal.aborted) await Bun.sleep(1000)
    }
  })()

  return { connected: connected.promise }
}
