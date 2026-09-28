/**
 * PoC integration seam for process-level sandboxing: run a command under the OS
 * sandbox and, when a denial blocks a path, ask the caller to approve it and
 * retry.
 *
 * The runner is either a standalone `miao-run` binary (`MIAO_RUN` or a sibling of
 * the executable, used in dev and as an override) or, in a released single-file
 * build, the `miao` binary itself re-executed through the hidden `__sandbox-run`
 * command. Self-exec keeps the release a single signed file instead of shipping
 * a second platform-specific executable.
 *
 * Wired into the shell tool when `MIAO_SANDBOX` is on: it seeds the allowlist
 * from the directories the permission flow already approved, runs the command
 * through the runner, and asks for any path the kernel denies before retrying.
 * `runSandboxed` is the standalone helper used by tests and manual runs.
 */
import { existsSync } from "fs"
import os from "os"
import path from "path"
import { native as addon } from "@miao/native"
import { Flag } from "@miao/core/flag/flag"

declare global {
  const MIAO_PACKAGED: boolean | undefined
}

export interface SandboxRunner {
  program: string
  /** Arguments inserted before the sandbox arguments (e.g. the hidden command). */
  prefix: string[]
}

/**
 * Locate a sandbox runner: `MIAO_RUN`, then a `miao-run` binary next to the
 * executable, then self-exec for a released single-file build whose addon
 * provides the sandbox backends. Without one the sandbox is unavailable and
 * callers fall back.
 */
export function resolveSandboxRunner(): SandboxRunner | undefined {
  const fromEnv = process.env.MIAO_RUN
  if (fromEnv && existsSync(fromEnv)) return { program: fromEnv, prefix: [] }
  const sibling = path.join(path.dirname(process.execPath), process.platform === "win32" ? "miao-run.exe" : "miao-run")
  if (existsSync(sibling)) return { program: sibling, prefix: [] }
  if (typeof MIAO_PACKAGED !== "undefined" && MIAO_PACKAGED && addon?.sandboxSupported()) {
    return { program: process.execPath, prefix: ["__sandbox-run"] }
  }
  return undefined
}

/** Whether process-level sandboxing can run on this host. */
export function sandboxAvailable(): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") return false
  return resolveSandboxRunner() !== undefined
}

/** Whether sandboxing is opted in (`MIAO_SANDBOX`) and possible on this host. */
export function sandboxEnabled(): boolean {
  return Flag.MIAO_SANDBOX && sandboxAvailable()
}

export interface SandboxRunInput {
  /** Override the resolved runner, used by tests. */
  runner?: SandboxRunner
  command: string[]
  workdirs: string[]
  allowPaths?: string[]
  allowNetwork?: boolean
  compat?: boolean
  /** Return the paths the user approved; an empty array aborts the retry loop. */
  ask: (denied: string[]) => Promise<string[]>
  maxAttempts?: number
}

export interface SandboxRunResult {
  code: number
  allowPaths: string[]
  denied: string[]
}

export function sandboxArgs(
  input: Pick<SandboxRunInput, "command" | "workdirs" | "allowNetwork" | "compat">,
  allowPaths: string[],
  reportPath: string,
) {
  const args: string[] = []
  for (const workdir of input.workdirs) args.push("--workdir", workdir)
  for (const allowPath of allowPaths) args.push("--allow-path", allowPath)
  if (input.allowNetwork) args.push("--allow-network")
  if (input.compat) args.push("--compat")
  args.push("--deny-report", reportPath, "--", ...input.command)
  return args
}

export async function runSandboxed(input: SandboxRunInput): Promise<SandboxRunResult> {
  const runner = input.runner ?? resolveSandboxRunner()
  if (!runner) throw new Error("no sandbox runner available")
  const allowPaths = [...(input.allowPaths ?? [])]
  const maxAttempts = input.maxAttempts ?? 3
  let denied: string[] = []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reportPath = path.join(os.tmpdir(), `miao-deny-${crypto.randomUUID()}.json`)
    const process = Bun.spawn([runner.program, ...runner.prefix, ...sandboxArgs(input, allowPaths, reportPath)], {
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await process.exited
    denied = await readDenyReport(reportPath)
    await Bun.file(reportPath)
      .delete()
      .catch(() => {})
    if (code === 0 || denied.length === 0) return { code, allowPaths, denied }

    const approved = await input.ask(denied)
    if (approved.length === 0) return { code, allowPaths, denied }
    allowPaths.push(...approved)
  }

  return { code: 1, allowPaths, denied }
}

async function readDenyReport(reportPath: string): Promise<string[]> {
  try {
    const parsed = (await Bun.file(reportPath).json()) as { denied?: unknown }
    if (!Array.isArray(parsed.denied)) return []
    return parsed.denied.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}
