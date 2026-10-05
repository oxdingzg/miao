import { Flag } from "@miao/core/flag/flag"
import { Context } from "effect"

// The hosted miao web app talks to a local server, so its origin must pass the
// origin check. opencode's hosted app is not trusted: it is a different product.
// The trusted host is derived from the configured web UI upstream so a
// deployment can move it without a source edit. Subdomains of the upstream's
// parent domain are trusted so sibling hosted origins keep working.
function trustedWebOrigin() {
  const upstream = new URL(Flag.MIAO_WEB_UI_UPSTREAM)
  const labels = upstream.hostname.split(".")
  const parent = labels.length > 2 ? labels.slice(1).join(".") : upstream.hostname
  return { host: upstream.hostname, parent }
}

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@miao/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  const trusted = trustedWebOrigin()
  const host = input.startsWith("https://") ? input.slice("https://".length).split(/[/:]/, 1)[0]?.toLowerCase() : undefined
  if (host && (host === trusted.host || host === trusted.parent || host.endsWith(`.${trusted.parent}`))) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
