// A connector over an in-memory network, standing in for networks like Telegram
// where logging in (a pasted token) does not tell who the owner is, so a pairing
// code decides. Also the module the third-party loading test imports.
import { defineConnector, type Channel, type Inbound } from "../../src"

export type EchoNetwork = ReturnType<typeof createEchoNetwork>

export function createEchoNetwork() {
  const sent: Array<{ to: string; text: string; reply?: unknown }> = []
  const queue: Array<{ from: string; text: string; id: string }> = []
  const state = { listener: undefined as ((message: { from: string; text: string; id: string }) => void) | undefined }
  return {
    sent,
    deliver: (message: { from: string; text: string; id: string }) => {
      if (state.listener) return state.listener(message)
      queue.push(message)
    },
    /** The channel lost its connection; messages queue until it reconnects. */
    drop: () => {
      state.listener = undefined
    },
    subscribe: (listener: (message: { from: string; text: string; id: string }) => void) => {
      state.listener = listener
      queue.splice(0).forEach(listener)
    },
    connected: () => state.listener !== undefined,
  }
}

export const echo = defineConnector<{ token: string }>({
  id: "echo",
  name: "Echo",
  description: "In-memory test network",
  transport: "socket",
  pairing: true,
  capabilities: { buttons: false, push: true, maxLength: 50 },
  login: async function* () {
    const input = yield { type: "form", title: "Echo bot", fields: [{ key: "token", label: "Token", secret: true }] }
    const token = typeof input === "object" ? input.token : undefined
    if (!token) {
      yield { type: "error", message: "token required" }
      return
    }
    yield { type: "progress", message: "checking token" }
    yield { type: "done", account: { id: `bot-${token}`, label: "Echo bot" }, credentials: { token } }
  },
  parse: (value) => {
    const token = typeof value === "object" && value !== null ? (value as { token?: unknown }).token : undefined
    return typeof token === "string" ? { token } : undefined
  },
  pairLink: (credentials, code) => `echo://bot-${credentials.token}?start=${code}`,
  connect: (_credentials, context): Channel => {
    const network = context.options.network as EchoNetwork
    const seen = new Set<string>()
    const timer = { reconnect: undefined as ReturnType<typeof setInterval> | undefined }
    return {
      id: "echo",
      capabilities: { buttons: false, push: true, maxLength: 50 },
      start: async (onMessage) => {
        const listen = () =>
          network.subscribe((message) => {
            if (seen.has(message.id)) return
            seen.add(message.id)
            void onMessage({ user: message.from, text: message.text, reply: message.id } satisfies Inbound)
          })
        listen()
        timer.reconnect = setInterval(() => {
          if (!network.connected()) listen()
        }, 10)
      },
      stop: async () => {
        clearInterval(timer.reconnect)
        network.drop()
      },
      send: async (user, text, reply) => {
        const pieces = [...text].length <= 50 ? [text] : (text.match(/[\s\S]{1,50}/gu) ?? [])
        pieces.forEach((piece) => network.sent.push({ to: user, text: piece, reply }))
        return { ok: true, sent: pieces.length }
      },
      typing: async () => undefined,
    }
  },
})
