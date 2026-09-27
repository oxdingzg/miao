/**
 * PoC integration seam for `miao-run`: run a command under the seatbelt sandbox
 * and, when a denial blocks a path, ask the caller to approve it and retry.
 *
 * Not wired into the live bash tool yet. The intended wiring is: the bash tool
 * executes through `runSandboxed` and passes its permission prompt as `ask`.
 */
import { existsSync } from "fs"
import os from "os"
import path from "path"

/**
 * Locate the `miao-run` binary: `MIAO_RUN` first, then next to the running
 * executable. A released binary must ship `miao-run` alongside it (or set
 * `MIAO_RUN`); until then the sandbox is simply unavailable and callers fall back.
 */
export function resolveMiaoRun(): string | undefined {
  const fromEnv = process.env.MIAO_RUN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const sibling = path.join(path.dirname(process.execPath), process.platform === "win32" ? "miao-run.exe" : "miao-run")
  if (existsSync(sibling)) return sibling
  return undefined
}

/** Whether process-level sandboxing can run on this host. */
export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && resolveMiaoRun() !== undefined
}

export interface SandboxRunInput {
  /** Path to the `miao-run` binary. */
  binary: string
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
  const allowPaths = [...(input.allowPaths ?? [])]
  const maxAttempts = input.maxAttempts ?? 3
  let denied: string[] = []

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reportPath = path.join(os.tmpdir(), `miao-deny-${crypto.randomUUID()}.json`)
    const process = Bun.spawn([input.binary, ...sandboxArgs(input, allowPaths, reportPath)], {
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
