import { InstallationExecutable } from "@miao/core/installation/executable"
export * as SandboxRunner from "./runner"

/**
 * Sandbox runner: run one child under the OS sandbox. macOS builds a seatbelt
 * profile and spawns `sandbox-exec`; Linux applies a Landlock ruleset to this
 * process and spawns the command, which inherits it. Mirrors
 * `crates/miao-native`'s `miao-run` binary so every entry point shares one
 * behavior.
 *
 * Entry points, in resolution order:
 * - `MIAO_RUN` or a `miao-run` binary next to the executable (dev override);
 * - a released single-file build re-executing itself through the hidden
 *   `miao __sandbox-run` command, which keeps the release a single signed file;
 * - a source checkout running `bun src/sandbox/main.ts` when the native addon
 *   is built, so `miao-dev` can sandbox without a separate binary.
 */
import { existsSync, writeFileSync } from "fs"
import path from "path"
import { native as addon } from "@miao/native"
import { SandboxPolicy } from "./policy"

// Defined by `packages/miao/script/build.ts` for compiled single-file builds.
declare const MIAO_PACKAGED: boolean | undefined

export interface Runner {
  readonly program: string
  /** Arguments inserted before the sandbox arguments (e.g. the hidden command). */
  readonly prefix: readonly string[]
}

export type Backend = "seatbelt" | "landlock" | "appcontainer"

/** The kernel mechanism this platform sandboxes with, if any. */
export function backend(): Backend | undefined {
  if (process.platform === "darwin") return existsSync("/usr/bin/sandbox-exec") ? "seatbelt" : undefined
  if (process.platform === "linux") return "landlock"
  if (process.platform === "win32") return "appcontainer"
  return undefined
}

/** Locate a sandbox runner, or `undefined` when none can run on this host. */
export function resolve(): Runner | undefined {
  const fromEnv = process.env.MIAO_RUN
  if (fromEnv && existsSync(fromEnv)) return { program: fromEnv, prefix: [] }
  const sibling = path.join(
    path.dirname(InstallationExecutable.executable),
    process.platform === "win32" ? "miao-run.exe" : "miao-run",
  )
  if (existsSync(sibling)) return { program: sibling, prefix: [] }
  if (!addon?.sandboxSupported()) return undefined
  if (typeof MIAO_PACKAGED !== "undefined" && MIAO_PACKAGED)
    return { program: InstallationExecutable.executable, prefix: ["__sandbox-run"] }
  // A compiled build without the define cannot re-execute a source file.
  if (!path.basename(InstallationExecutable.executable).startsWith("bun")) return undefined
  // The runner inherits the command's cwd; ignore any bunfig.toml (and its
  // preloads) that the sandboxed project ships.
  return {
    program: InstallationExecutable.executable,
    prefix: [
      `--config=${process.platform === "win32" ? path.join(import.meta.dir, "empty-bunfig.toml") : "/dev/null"}`,
      path.join(import.meta.dir, "main.ts"),
    ],
  }
}

/** Whether process-level sandboxing can run on this host. */
export function available() {
  return backend() !== undefined && resolve() !== undefined
}

export interface Options {
  workdirs: string[]
  allowPaths: string[]
  allowNetwork: boolean
  compat: boolean
  denyReport?: string
  printProfile: boolean
  command: string[]
}

export function parseArgs(argv: readonly string[]): Options | { error: string } {
  const options: Options = {
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

/** Run the runner command line and return the child's exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ("error" in parsed) {
    process.stderr.write(`miao: ${parsed.error}\n`)
    return 2
  }

  const profile = addon?.sandboxProfile(parsed.workdirs, parsed.allowPaths, parsed.allowNetwork, parsed.compat) ?? ""
  if (parsed.printProfile) {
    process.stdout.write(profile)
    return 0
  }

  if (process.platform === "win32") return runWindows(parsed)

  if (process.platform === "linux") {
    try {
      addon?.sandboxRestrict(parsed.workdirs, parsed.allowPaths, parsed.allowNetwork)
    } catch (error) {
      process.stderr.write(
        `miao: failed to apply landlock: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      return 125
    }
  }

  if (process.platform !== "darwin" && process.platform !== "linux") {
    process.stderr.write("miao: no sandbox backend for this platform; running unsandboxed\n")
  }

  const invocation =
    process.platform === "darwin" ? ["/usr/bin/sandbox-exec", "-p", profile, ...parsed.command] : parsed.command
  const child = Bun.spawn(invocation, { stdin: "inherit", stdout: "inherit", stderr: "pipe" })

  // Stream the child's stderr through while collecting the paths a denial
  // blocked, so the caller can offer to retry with them allowed.
  const denied: string[] = []
  const reader = child.stderr.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      process.stderr.write(line + "\n")
      const blocked = SandboxPolicy.parseDeniedLine(line)
      if (blocked) denied.push(blocked)
      index = buffer.indexOf("\n")
    }
  }
  if (buffer.length > 0) {
    process.stderr.write(buffer)
    const blocked = SandboxPolicy.parseDeniedLine(buffer)
    if (blocked) denied.push(blocked)
  }

  const code = await child.exited
  if (parsed.denyReport) writeDenyReport(parsed.denyReport, denied, code)
  return code
}

/**
 * Windows has no in-process restriction a child inherits: the AppContainer
 * applies at CreateProcess time, so the addon spawns and waits for the child
 * itself, with stdio inherited. Denied paths are not recoverable on Windows
 * (access-denied errors carry no path), so the report lists none.
 */
async function runWindows(parsed: Options): Promise<number> {
  const spawnSandboxed = addon?.sandboxSpawn
  if (!spawnSandboxed) {
    process.stderr.write("miao: windows sandbox needs the native addon; running unsandboxed\n")
  }
  const code = spawnSandboxed
    ? spawnSandboxed(parsed.workdirs, parsed.allowPaths, parsed.allowNetwork, parsed.command)
    : await Bun.spawn(parsed.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
  if (parsed.denyReport) writeDenyReport(parsed.denyReport, [], code)
  return code
}

function writeDenyReport(file: string, denied: string[], exitCode: number) {
  try {
    writeFileSync(file, JSON.stringify({ denied, exitCode }))
  } catch {
    // The report is best-effort; a failure must not mask the command's exit code.
  }
}
