import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EngineOptions } from "./client"

/** Materialize trusted global servers for one native owner, never project config. */
export function prepareMcpConfig(options: EngineOptions) {
  if (options.mcpConfigFile || !options.mcpSettings?.servers || !options.policyFile) return
  const policy: unknown = JSON.parse(readFileSync(options.policyFile, "utf8"))
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
      // Refuse unsupported settings rather than silently dropping their semantics.
      if (
        (server.type === "local" && server.cwd !== undefined) ||
        server.timeout ||
        options.mcpSettings?.timeout ||
        Object.keys(server.call_meta ?? {}).length
      ) {
        throw new Error(`Native MCP shared configuration does not support cwd, call_meta or custom timeouts: ${name}`)
      }
      if (server.type === "remote") {
        if (server.oauth !== false)
          throw new Error(
            `Native MCP shared configuration requires oauth: false until OAuth routing is configured: ${name}`,
          )
        return { name, url: server.url, headers: server.headers ?? {} }
      }
      return { name, argv: server.command, env: server.environment ?? {} }
    })
    .filter((server) => server !== undefined)
  if (!servers.length) return

  const directory = mkdtempSync(path.join(os.tmpdir(), "miao-native-mcp-"))
  const file = path.join(directory, "mcp.json")
  const dispose = () => rmSync(directory, { recursive: true, force: true })
  try {
    writeFileSync(file, JSON.stringify(servers), { encoding: "utf8", mode: 0o600, flag: "wx" })
    return { file, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
