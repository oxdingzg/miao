export * as SecureChannel from "./secure-channel"

import { Option, Schema } from "effect"

const encoded = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const key = encoded.check(Schema.isLengthBetween(87, 87))
const challenge = encoded.check(Schema.isLengthBetween(43, 43))
const signature = encoded.check(Schema.isLengthBetween(86, 86))
const identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/))
const ClientHello = Schema.Struct({
  version: Schema.Literal(1),
  hostID: identity,
  runtimeID: identity,
  signingKey: key,
  agreementKey: key,
  challenge: challenge,
  signature: signature,
})
const ServerHello = Schema.Struct({
  version: Schema.Literal(1),
  hostID: identity,
  runtimeID: identity,
  connectionID: identity,
  signingKey: key,
  agreementKey: key,
  challenge: challenge,
  clientChallenge: challenge,
  signature: signature,
})

export type Identity = { readonly keys: CryptoKeyPair; readonly publicKey: string }
export type Target = { readonly hostID: string; readonly runtimeID: string }
export type ClientHello = typeof ClientHello.Type
export type ServerHello = typeof ServerHello.Type
export type Channel = {
  readonly seal: (plaintext: Uint8Array<ArrayBuffer>) => Promise<string>
  readonly open: (packet: string) => Promise<Uint8Array<ArrayBuffer>>
}

export async function createIdentity(options: { extractable?: boolean } = {}): Promise<Identity> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, options.extractable ?? true, ["sign", "verify"])
  return { keys, publicKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))) }
}

/** The caller must obtain the trusted host key from local pairing, never the Hub. */
export async function startClient(device: Identity, target: Target) {
  const keys = await agreement()
  const payload = {
    version: 1 as const,
    ...target,
    signingKey: device.publicKey,
    agreementKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
    challenge: encode(crypto.getRandomValues(new Uint8Array(32))),
  }
  const hello: ClientHello = {
    ...payload,
    signature: await sign(device.keys.privateKey, ["miao.control.client.v1", payload]),
  }
  const state = { finished: false }
  return {
    hello,
    finish: async (input: unknown, trustedHostKey: string) => {
      if (state.finished) throw new Error("Handshake already used")
      state.finished = true
      const server = Schema.decodeUnknownOption(ServerHello)(input)
      if (Option.isNone(server)) throw new Error("Invalid server handshake")
      const peer = server.value
      if (
        peer.hostID !== target.hostID ||
        peer.runtimeID !== target.runtimeID ||
        peer.signingKey !== trustedHostKey ||
        peer.clientChallenge !== hello.challenge
      )
        throw new Error("Server identity or challenge mismatch")
      const { signature, ...payload } = peer
      if (!(await verify(trustedHostKey, signature, ["miao.control.server.v1", hello, payload])))
        throw new Error("Invalid server signature")
      return {
        connectionID: peer.connectionID,
        channel: await channel(keys.privateKey, peer.agreementKey, hello, peer, "client"),
      }
    },
  }
}

/** Authenticate the explicitly selected device key. The caller must separately
 * authorize every data-plane request; a provisional pairing channel grants none. */
export async function acceptClient(
  host: Identity,
  target: Target,
  connectionID: string,
  input: unknown,
  trustedDeviceKey: string,
) {
  const decoded = Schema.decodeUnknownOption(ClientHello)(input)
  if (Option.isNone(decoded)) throw new Error("Invalid client handshake")
  const client = decoded.value
  if (
    client.hostID !== target.hostID ||
    client.runtimeID !== target.runtimeID ||
    client.signingKey !== trustedDeviceKey
  )
    throw new Error("Client identity or target mismatch")
  const { signature, ...payload } = client
  if (!(await verify(trustedDeviceKey, signature, ["miao.control.client.v1", payload])))
    throw new Error("Invalid client signature")
  const keys = await agreement()
  const reply = {
    version: 1 as const,
    ...target,
    connectionID,
    signingKey: host.publicKey,
    agreementKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
    challenge: encode(crypto.getRandomValues(new Uint8Array(32))),
    clientChallenge: client.challenge,
  }
  const hello: ServerHello = {
    ...reply,
    signature: await sign(host.keys.privateKey, ["miao.control.server.v1", client, reply]),
  }
  return { hello, channel: await channel(keys.privateKey, client.agreementKey, client, hello, "host") }
}

async function agreement() {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
}

async function sign(key: CryptoKey, value: unknown) {
  return encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, json(value))))
}

async function verify(key: string, signature: string, value: unknown) {
  const imported = await crypto.subtle.importKey("raw", decode(key), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ])
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported, decode(signature), json(value))
}

async function channel(
  privateKey: CryptoKey,
  peerKey: string,
  client: ClientHello,
  host: ServerHello,
  role: "client" | "host",
): Promise<Channel> {
  const imported = await crypto.subtle.importKey(
    "raw",
    decode(peerKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: imported }, privateKey, 256)
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
  const transcript = new Uint8Array(await crypto.subtle.digest("SHA-256", json([client, host])))
  const derive = (direction: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: transcript, info: json(["miao.control.channel.v1", direction]) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )
  const clientKey = await derive("client-to-host")
  const hostKey = await derive("host-to-client")
  const sendKey = role === "client" ? clientKey : hostKey
  const receiveKey = role === "client" ? hostKey : clientKey
  const state = { sent: 0, received: 0, send: Promise.resolve(), receive: Promise.resolve() }
  return {
    seal: (plaintext) => {
      const bytes = plaintext.slice()
      const result = state.send.then(async () => {
        if (plaintext.byteLength > 128 * 1024) throw new Error("Secure frame exceeds limit")
        if (state.sent >= Number.MAX_SAFE_INTEGER) throw new Error("Channel sequence exhausted")
        const header = new Uint8Array(9)
        header[0] = 1
        new DataView(header.buffer).setBigUint64(1, BigInt(++state.sent))
        const nonce = new Uint8Array(12)
        nonce.set(header.subarray(1), 4)
        const encrypted = new Uint8Array(
          await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, sendKey, bytes),
        )
        const packet = new Uint8Array(header.length + encrypted.length)
        packet.set(header)
        packet.set(encrypted, header.length)
        return encode(packet)
      })
      state.send = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    open: (input) => {
      const result = state.receive.then(async () => {
        if (input.length > 180 * 1024) throw new Error("Secure frame exceeds limit")
        const packet = decode(input)
        if (packet.length < 25 || packet[0] !== 1) throw new Error("Invalid secure frame")
        const sequence = new DataView(packet.buffer).getBigUint64(1)
        if (sequence !== BigInt(state.received + 1)) throw new Error("Replayed or out-of-order secure frame")
        const nonce = new Uint8Array(12)
        nonce.set(packet.subarray(1, 9), 4)
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: packet.subarray(0, 9) },
          receiveKey,
          packet.subarray(9),
        )
        state.received++
        return new Uint8Array(plaintext)
      })
      state.receive = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}

function json(value: unknown) {
  return new TextEncoder().encode(canonicalJSON(value))
}

export function canonicalJSON(value: unknown) {
  return JSON.stringify(canonical(value))
}

function encode(value: Uint8Array<ArrayBuffer>) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid binary encoding")
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  if (encode(bytes) !== value) throw new Error("Non-canonical binary encoding")
  return bytes
}

// Handshake objects contain ASCII strings and integers. Sorted object keys
// match Foundation JSONSerialization.sortedKeys without escaping slashes.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => [key, canonical(value)]),
    )
  return value
}
