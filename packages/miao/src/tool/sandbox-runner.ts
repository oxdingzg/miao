/**
 * Hidden `miao __sandbox-run` entry point. A compiled single-file binary cannot
 * ship a separate `miao-run` sidecar, so it re-executes itself through this
 * command to run a child under the OS sandbox: macOS builds a seatbelt profile
 * and spawns `sandbox-exec`; Linux applies a Landlock ruleset to this process
 * and spawns the command, which inherits it. Mirrors `crates/miao-native`'s
 * `miao-run` binary so both entry points share one behavior.
 */
import { writeFileSync } from "fs"
import { native as addon } from "@miao/native"
import { errorMessage } from "@/util/error"

export interface SandboxRunOptions {
  workdirs: string[]
  allowPaths: string[]
  allowNetwork: boolean
  compat: boolean
  denyReport?: string
  printProfile: boolean
  command: string[]
}

export function parseSandboxArgs(argv: string[]): SandboxRunOptions | { error: string } {
  const options: SandboxRunOptions = {
    workdirs: [],
    allowPaths: [],
    allowNetwork: false,
    compat: false,
    printProfile: false,
    command: [],
  }
  let commandStarted = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (commandStarted) {
      options.command.push(arg)
      continue
    }
    switch (arg) {
      case "--workdir": {
        const value = argv[++i]
        if (value === undefined) return { error: "--workdir requires a path" }
        options.workdirs.push(value)
        break
      }
      case "--allow-path": {
        const value = argv[++i]
        if (value === undefined) return { error: "--allow-path requires a path" }
        options.allowPaths.push(value)
        break
      }
      case "--deny-report": {
        const value = argv[++i]
        if (value === undefined) return { error: "--deny-report requires a path" }
        options.denyReport = value
        break
      }
      case "--allow-network":
        options.allowNetwork = true
        break
      case "--compat":
        options.compat = true
        break
      case "--print-profile":
        options.printProfile = true
        break
      case "--":
        commandStarted = true
        break
      default:
        return { error: `unknown argument: ${arg}` }
    }
  }
  if (options.command.length === 0 && !options.printProfile) {
    return { error: "no command given; use `-- <command> [args...]`" }
  }
  return options
}

/// Extract the blocked path from a shell error line such as
/// `sh: /path/to/file: Operation not permitted`.
export function parseDeniedLine(line: string): string | undefined {
  const marker = "Operation not permitted"
  const at = line.indexOf(marker)
  if (at < 0) return undefined
  let prefix = line.slice(0, at).trimEnd()
  if (!prefix.endsWith(":")) return undefined
  prefix = prefix.slice(0, -1).trimEnd()
  const separator = prefix.indexOf(": ")
  const path = (separator >= 0 ? prefix.slice(separator + 2) : prefix).trim()
  return path.length > 0 ? path : undefined
}

export async function sandboxRun(argv: string[]): Promise<number> {
  const parsed = parseSandboxArgs(argv)
  if ("error" in parsed) {
    process.stderr.write(`miao: ${parsed.error}\n`)
    return 2
  }

  const profile = addon?.sandboxProfile(parsed.workdirs, parsed.allowPaths, parsed.allowNetwork, parsed.compat) ?? ""
  if (parsed.printProfile) {
    process.stdout.write(profile)
    return 0
  }

  if (process.platform === "linux") {
    try {
      addon?.sandboxRestrict(parsed.workdirs, parsed.allowPaths, parsed.allowNetwork)
    } catch (error) {
      process.stderr.write(`miao: failed to apply landlock: ${errorMessage(error)}\n`)
      return 125
    }
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    process.stderr.write("miao: no sandbox backend for this platform; running unsandboxed\n")
  }

  const invocation =
    process.platform === "darwin"
      ? ["/usr/bin/sandbox-exec", "-p", profile, ...parsed.command]
      : parsed.command
  const child = Bun.spawn(invocation, { stdin: "inherit", stdout: "inherit", stderr: "pipe" })

  // Stream the child's stderr through while collecting the paths a denial
  // blocked, so the caller can offer to retry with them allowed.
  const denied: string[] = []
  const reader = child.stderr.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      process.stderr.write(line + "\n")
      const path = parseDeniedLine(line)
      if (path) denied.push(path)
      index = buffer.indexOf("\n")
    }
  }
  if (buffer.length > 0) {
    process.stderr.write(buffer)
    const path = parseDeniedLine(buffer)
    if (path) denied.push(path)
  }

  const code = await child.exited
  if (parsed.denyReport) writeDenyReport(parsed.denyReport, denied, code)
  return code
}

function writeDenyReport(path: string, denied: string[], exitCode: number) {
  try {
    writeFileSync(path, JSON.stringify({ denied, exitCode }))
  } catch {
    // The report is best-effort; a failure must not mask the command's exit code.
  }
}
