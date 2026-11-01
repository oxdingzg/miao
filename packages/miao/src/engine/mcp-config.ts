import { readFileSync } from "node:fs"
import path from "node:path"
import type { EngineOptions } from "./client"

/**
 * Hand trusted global servers to one native owner, never project config.
 *
 * The servers travel as inline JSON through the child's environment: there is
 * no temporary file to keep outside the model-writable workspace, to chmod, or
 * to clean up after a crash.
 */
export function prepareMcpConfig(options: EngineOptions, inherited: Record<string, string | undefined> = process.env) {
  if (options.mcpConfigFile || !options.mcpSettings?.servers) return
  // Without an explicit operator policy the engine derives the product policy
  // (workspace mode, MCP allowed) from the config directory; only a policy
  // file still needs reading.
  const policy: unknown = options.policyFile
    ? JSON.parse(readFileSync(options.policyFile, "utf8"))
    : { mode: "workspace", allow_mcp: true }
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("mode" in policy) ||
    policy.mode !== "workspace" ||
    !("allow_mcp" in policy) ||
    policy.allow_mcp !== true
  )
    return

  const servers = Object.entries(options.mcpSettings.servers)
    .map(([name, server]) => {
      if (server.disabled) return
      const startup = server.timeout?.startup ?? options.mcpSettings?.timeout?.startup
      const request = server.timeout?.request ?? options.mcpSettings?.timeout?.request
      const timeout = {
        ...(startup === undefined ? {} : { startup }),
        ...(request === undefined ? {} : { request }),
      }
      const limits = {
        ...(Object.keys(timeout).length ? { timeout } : {}),
        ...(Object.keys(server.call_meta ?? {}).length ? { call_meta: server.call_meta } : {}),
      }
      if (server.type === "remote") {
        if (server.oauth !== false)
          throw new Error(
            `Native MCP shared configuration requires oauth: false until OAuth routing is configured: ${name}`,
          )
        return {
          name,
          url: server.url,
          headers: server.headers ?? {},
          ...limits,
          ...(options.mcpAuthorityRevisions?.[name] === undefined
            ? {}
            : { authority_revision: options.mcpAuthorityRevisions[name] }),
        }
      }
      return {
        name,
        argv: server.command,
        env: server.environment ?? {},
        ...(server.cwd === undefined ? {} : { cwd: path.resolve(options.workspace, server.cwd) }),
        ...limits,
      }
    })
    .filter((server) => server !== undefined)
  if (!servers.length) return

  // The engine normally inherits a small fixed environment. Forward only
  // variables explicitly named by these authorized servers' identity templates.
  const environment = Object.fromEntries(
    servers.flatMap((server) =>
      Object.values(server.call_meta ?? {}).flatMap((template) =>
        Array.from(template.matchAll(/\{env:([A-Za-z0-9_]+)\}/g)).flatMap((match) => {
          const key = match[1]
          const value = key === undefined ? undefined : inherited[key]
          return key !== undefined && value !== undefined ? [[key, value] as const] : []
        }),
      ),
    ),
  )

  return { servers: JSON.stringify(servers), environment }
}
