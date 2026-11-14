export * as PairingLink from "./pairing-link"

import { Schema } from "effect"
import { RemoteAccess } from "@miao/schema/remote-access"

/** Invitation secrets stay in fragments, never query strings or server routes. */
export function create(invitation: RemoteAccess.Invitation, browserURL?: string): string {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(invitation))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
  if (!browserURL) return "miao://pair#" + encoded
  const url = new URL(browserURL)
  if (
    url.origin !== new URL(invitation.hubURL).origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Browser pairing URL must be on the invitation Hub")
  url.hash = "pair=" + encoded
  return url.href
}

export function parse(value: string, hubURL?: string, allowLoopbackHTTP = false): RemoteAccess.Invitation {
  if (value.length > 8192) throw new Error("Invitation too large")
  const raw = value.trim()
  if (raw.startsWith("{")) return validate(JSON.parse(raw), hubURL)
  const url = new URL(raw)
  const native = url.protocol === "miao:" && url.hostname === "pair" && !url.pathname
  const web =
    (url.protocol === "https:" ||
      (allowLoopbackHTTP && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
    url.hash.startsWith("#pair=")
  if ((!native && !web) || url.username || url.password || url.search) throw new Error("Invalid invitation link")
  const encoded = url.hash.slice(web ? 6 : 1)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid invitation link")
  const bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
  const invitation = validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), hubURL)
  if (web && url.origin !== new URL(invitation.hubURL).origin) throw new Error("Invalid invitation Hub")
  return invitation
}

function validate(value: unknown, hubURL?: string): RemoteAccess.Invitation {
  const invitation = Schema.decodeUnknownSync(RemoteAccess.Invitation, { onExcessProperty: "error" })(value)
  if (hubURL && new URL(invitation.hubURL).origin !== new URL(hubURL).origin) throw new Error("Invalid invitation Hub")
  if (invitation.expiresAt <= Date.now()) throw new Error("Invitation expired")
  return invitation
}
