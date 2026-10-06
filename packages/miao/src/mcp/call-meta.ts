export * as CallMeta from "./call-meta"

/**
 * Per-call identity injection for MCP tools/call, in the style of an official
 *增值 channel: the host stamps every call with fresh credentials instead of
 * baking them into the environment. Values support `{env:VAR}` placeholders
 * that are re-read on EVERY call — an env-style snapshot goes stale the moment
 * the issuing service rotates its token, and the next call then fails with a
 * 401 that no retry can fix. Callers treat a 401 as "retry the whole call so
 * a fresh stamp is read", never as "retry unchanged".
 */

const ENV_PLACEHOLDER = /\{env:([^}]+)\}/g

const fresh = (spec: Record<string, string>) =>
  Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, value.replace(ENV_PLACEHOLDER, (_, name) => process.env[name] ?? "")]))

/**
 * Patch a connected MCP client so every tools/call carries `_meta` derived
 * from the spec, re-read at call time. Keys configured here win over whatever
 * the caller supplied; unspecified caller keys pass through.
 */
export function wrap<Client extends { callTool: (...args: never[]) => unknown }>(
  client: Client,
  spec: Record<string, string> | undefined,
): void {
  if (!spec || Object.keys(spec).length === 0) return
  const callTool = client.callTool.bind(client) as (params: Record<string, unknown>, ...rest: unknown[]) => unknown
  ;(client as { callTool: unknown }).callTool = (params: Record<string, unknown>, ...rest: unknown[]) =>
    callTool({ ...params, _meta: { ...((params._meta as Record<string, unknown>) ?? {}), ...fresh(spec) } }, ...rest)
}
