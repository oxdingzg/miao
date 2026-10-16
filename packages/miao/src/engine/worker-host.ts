#!/usr/bin/env bun
import { tool } from "@miao/plugin/tool"
import path from "node:path"
import { pathToFileURL } from "node:url"
import readline from "node:readline"
import type { z } from "zod"

/**
 * ADR-12 extension compatibility worker: the stdio newline-JSON process the
 * native engine spawns through `--worker-config` and drives with `hello` /
 * `tool.list` / `tool.call` / `shutdown`. This host serves the workspace's own
 * custom tool files (`{tool,tools}/*.{js,ts}` under `.miao` and `.opencode`,
 * the V1-compatible convention) so real project tools keep working when a
 * Session runs on the native engine.
 *
 * Authorization lives at the engine boundary: the engine marks worker tools
 * "requires external-tool authorization" and gates model-initiated calls
 * through its own permission flow. Inside the host there is no approver, so a
 * tool that calls `context.ask(...)` fails with a clear error instead of being
 * granted silently.
 */

const PROTOCOL = 1

const directoryFlag = process.argv.indexOf("--directory")
const fallbackDirectory = directoryFlag !== -1 && process.argv[directoryFlag + 1]
  ? process.argv[directoryFlag + 1]!
  : process.cwd()

type ToolDefinition = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: Record<string, unknown>, context: {
    sessionID: string
    messageID: string
    agent: string
    directory: string
    worktree: string
    abort: AbortSignal
    metadata(input: { title?: string; metadata?: { [key: string]: unknown } }): void
    ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void>
  }): Promise<unknown>
}

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" && value !== null
  && typeof (value as { description?: unknown }).description === "string"
  && typeof (value as { execute?: unknown }).execute === "function"
  && typeof (value as { args?: unknown }).args === "object"

let workspace = fallbackDirectory
let catalog: {
  name: string
  description: string
  input_schema: Record<string, unknown>
  parse: (input: unknown) => Record<string, unknown>
  execute: ToolDefinition["execute"]
}[] = []

const discover = async (workspaceDirectory: string) => {
  workspace = workspaceDirectory
  const debug: string[] = []
  const roots = [
    path.join(workspace, ".miao"),
    path.join(workspace, ".opencode"),
    ...(process.env.MIAO_CONFIG_DIR ? [process.env.MIAO_CONFIG_DIR] : []),
  ]
  const found = new Map<string, ToolDefinition>()
  for (const root of roots) {
    for (const kind of ["tool", "tools"]) {
      const directory = path.join(root, kind)
      let files: string[] = []
      try {
        files = require("node:fs")
          .readdirSync(directory)
          .filter((file: string) => /\.(js|ts)$/.test(file))
          .map((file: string) => path.join(directory, file))
          .toSorted()
      } catch (error) {
        debug.push(`readdir ${directory}: ${String(error)}`)
        continue
      }
      for (const file of files) {
        try {
          const module = await import(pathToFileURL(file).href)
          const namespace = path.basename(file, path.extname(file))
          for (const [id, value] of Object.entries(module)) {
            if (!isToolDefinition(value)) continue
            // Later directories win on a name collision, matching the product loader.
            found.set(id === "default" ? namespace : `${namespace}_${id}`, value)
          }
        } catch (error) {
          debug.push(`import ${file}: ${String(error)}`)
        }
      }
    }
  }
  debug.push(`[worker-host] workspace=${workspaceDirectory} tools=${found.size} names=${JSON.stringify([...found.keys()])}`)
  debug.push(`[worker-host] .miao listing=${JSON.stringify((() => { try { return require("node:fs").readdirSync(path.join(workspaceDirectory, ".miao")) } catch (error) { return String(error) } })())}`)
  debug.push(`[worker-host] .miao/tool listing=${JSON.stringify((() => { try { return require("node:fs").readdirSync(path.join(workspaceDirectory, ".miao", "tool")) } catch (error) { return String(error) } })())}`)
  catalog = [...found.entries()].map(([name, definition]) => {
    const schema = tool.schema.object(definition.args ?? {})
    return {
      name,
      description: definition.description,
      input_schema: tool.schema.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
      parse: (input: unknown) => schema.parse(input ?? {}) as Record<string, unknown>,
      execute: definition.execute,
    }
  })
}

const context = () => ({
  sessionID: "ses_worker",
  messageID: "msg_worker",
  agent: "worker",
  directory: workspace,
  worktree: workspace,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {
    throw new Error(
      "interactive permission is unavailable for worker tools; the engine's external-tool authorization is the gate",
    )
  },
})

const reply = (id: number, result: unknown) => {
  process.stdout.write(JSON.stringify({ id, result }) + "\n")
}
const fail = (id: number, message: string) => {
  process.stdout.write(JSON.stringify({ id, error: { message } }) + "\n")
}

const dispatch = async (id: number, method: string, params: Record<string, unknown>): Promise<boolean> => {
  if (method === "hello") {
    const helloWorkspace = typeof params["workspace"] === "string" && params["workspace"] ? params["workspace"] : workspace
    await discover(helloWorkspace)
    reply(id, { protocol: PROTOCOL })
    return true
  }
  if (method === "tool.list") {
    reply(id, { tools: catalog.map(({ name, description, input_schema }) => ({ name, description, input_schema })) })
    return true
  }
  if (method === "tool.call") {
    const name = typeof params["name"] === "string" ? params["name"] : ""
    const registered = catalog.find((entry) => entry.name === name)
    if (!name || !registered) {
      fail(id, `unknown worker tool: ${name || "(missing)"}`)
      return true
    }
    try {
      const args = registered.parse(params["input"] ?? {})
      const result = await registered.execute(args, context())
      reply(id, { result })
    } catch (error) {
      fail(id, `tool execution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }
  if (method === "shutdown") {
    reply(id, {})
    process.exit(0)
  }
  return false
}

const lines = readline.createInterface({ input: process.stdin, terminal: false })
lines.on("line", (line) => {
  if (!line.trim()) return
  let frame: { id?: unknown; method?: unknown; params?: unknown }
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (typeof frame.id !== "number" || typeof frame.method !== "string") return
  const id = frame.id
  const method = frame.method
  dispatch(id, method, (frame.params ?? {}) as Record<string, unknown>).then((handled) => {
    if (!handled) fail(id, `unknown worker method: ${method}`)
  })
})
lines.on("close", () => process.exit(0))
