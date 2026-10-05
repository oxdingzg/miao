export * as BrowserChannel from "./browser-channel"

import type { RemoteAccess } from "@miao/schema/remote-access"
import { PairingProof } from "./pairing-proof"
import { SecureChannel } from "./secure-channel"

/** A one-use account ticket routes the socket; the pinned Agent key authenticates its encrypted contents. */
export async function connect(input: {
  hubURL: string
  ticket: string
  target: SecureChannel.Target
  identity: SecureChannel.Identity
  trustedHostKey: string
  invitation?: RemoteAccess.Invitation
  label?: string
  allowLoopbackHTTP?: boolean
}) {
  const url = new URL(input.hubURL)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(input.allowLoopbackHTTP && url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || !/^[A-Za-z0-9_-]{43}$/.test(input.ticket))
    throw new Error("Invalid relay origin or ticket")
  const handshake = await SecureChannel.startClient(input.identity, input.target)
  const hello = input.invitation
    ? await PairingProof.claim(input.invitation, input.label ?? "Browser", handshake.hello)
    : handshake.hello
  if (input.invitation && input.invitation.hostPublicKey !== input.trustedHostKey)
    throw new Error("Pairing host key mismatch")
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/v1/client"
  url.searchParams.set("hostID", input.target.hostID)
  const socket = new WebSocket(url, ["miao.control.v1", "miao.ticket." + input.ticket])
  const frames: string[] = []
  let bytes = 0
  let closed = false
  let wake: (() => void) | undefined
  const close = () => { closed = true; frames.length = 0; bytes = 0; wake?.(); socket.close() }
  socket.addEventListener("close", close)
  socket.addEventListener("error", close)
  socket.addEventListener("message", (event) => {
    if (closed) return
    if (typeof event.data !== "string" || event.data.length > 192 * 1024 || frames.length >= 128 ||
        bytes + event.data.length > 8 * 1024 * 1024) { close(); return }
    frames.push(event.data); bytes += event.data.length; wake?.()
  })
  async function next(timeout: number): Promise<string> {
    if (!frames.length && !closed) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { close(); resolve() }, timeout)
      wake = () => { clearTimeout(timer); wake = undefined; resolve() }
    })
    if (closed || !frames.length) throw new Error("Relay connection closed")
    const frame = frames.shift()!
    bytes -= frame.length
    return frame
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error("Relay connection timed out")) }, 15000)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        if (socket.protocol !== "miao.control.v1") { close(); reject(new Error("Relay protocol mismatch")); return }
        resolve()
      }, { once: true })
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Relay connection closed")) }, { once: true })
    })
    socket.send(encode(new TextEncoder().encode(JSON.stringify(hello))))
    const reply = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(await next(15000))))
    const authenticated = await handshake.finish(reply, input.trustedHostKey)
    let receiving = false
    return {
      connectionID: authenticated.connectionID,
      close,
      send: async (value: unknown) => {
        if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("Relay connection closed")
        const packet = await authenticated.channel.seal(new TextEncoder().encode(JSON.stringify(value)))
        if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("Relay connection closed")
        if (socket.bufferedAmount + packet.length > 1024 * 1024) { close(); throw new Error("Relay send buffer exceeded") }
        socket.send(packet)
      },
      receive: async (timeout = 30000): Promise<unknown> => {
        if (receiving) throw new Error("Only one receiver may consume the encrypted stream")
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error("Invalid receive timeout")
        receiving = true
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await authenticated.channel.open(await next(timeout))))
        } catch { close(); throw new Error("Encrypted relay stream could not be read") }
        finally { receiving = false }
      },
    }
  } catch { close(); throw new Error("Agent connection could not be authenticated") }
}

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) throw new Error("Invalid handshake frame")
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0))
}
