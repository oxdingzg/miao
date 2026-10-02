// An in-process channel: records what the Router sends and lets a caller inject
// inbound messages. Used by tests and as the reference for channel behavior.
import type { Capabilities, Channel, Inbound } from "./channel"

export type Sent = { readonly user: string; readonly text: string }

export function createMemoryChannel(input: { id?: string; capabilities?: Partial<Capabilities> } = {}) {
  const sent: Sent[] = []
  const typing: Array<{ readonly user: string; readonly on: boolean }> = []
  const handlers: Array<(message: Inbound) => Promise<void>> = []
  const capabilities: Capabilities = { buttons: false, push: true, maxLength: 2000, ...input.capabilities }
  const waiters = new Set<() => void>()

  const channel: Channel = {
    id: input.id ?? "memory",
    capabilities,
    start: async (onMessage) => {
      handlers.push(onMessage)
    },
    stop: async () => {
      handlers.length = 0
    },
    send: async (user, text) => {
      sent.push({ user, text })
      waiters.forEach((wake) => wake())
      return { ok: true, sent: 1 }
    },
    typing: async (user, on) => {
      typing.push({ user, on })
    },
  }

  return {
    channel,
    sent,
    typing,
    /** Delivers one inbound message and waits until the Router has handled it. */
    receive: (user: string, text: string) => Promise.all(handlers.map((handler) => handler({ user, text }))),
    /** Resolves with the first message sent at or after `from` that matches. */
    next: (match: (text: string) => boolean, from = 0, timeoutMs = 20_000) =>
      new Promise<Sent>((resolve, reject) => {
        const check = () => {
          const found = sent.slice(from).find((message) => match(message.text))
          if (!found) return false
          waiters.delete(check)
          clearTimeout(timer)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(
            new Error(`no matching message within ${timeoutMs}ms; sent:\n${sent.map((m) => m.text).join("\n---\n")}`),
          )
        }, timeoutMs)
        if (!check()) waiters.add(check)
      }),
  }
}
