import type { TuiInput } from "@miao/tui"
import { terminalTarget } from "@/plugin/miaotty"

export type Runtime = { runtimeID: string; storage: string }

/** Report from the observing client, never from the shared Runtime's environment. */
export function reporter(
  runtime?: Runtime,
  env: Record<string, string | undefined> = process.env,
): TuiInput["onSessionChange"] {
  const target = terminalTarget(env)
  if (!target) return undefined
  const state: {
    pending?: { value: Parameters<NonNullable<TuiInput["onSessionChange"]>>[0] }
    running: boolean
    previous?: string
  } = {
    running: false,
  }
  return (value) => {
    const signature = JSON.stringify(value ?? null)
    if (signature === state.previous) return
    state.previous = signature
    state.pending = { value }
    if (state.running) return
    state.running = true
    void (async () => {
      try {
        while (state.pending) {
          const next = state.pending.value
          state.pending = undefined
          const args = [
            target.exe,
            "--wait",
            "0",
            "state",
            "miao",
            "--pane",
            target.pane,
            "--state",
            next?.state ?? "idle",
            "--runtime-context",
            "-",
          ]
          if (next?.sessionID) args.push("--session", next.sessionID)
          if (next?.cwd) args.push("--cwd", next.cwd)
          const context =
            next === undefined
              ? null
              : runtime
                ? { kind: "owned", runtimeID: runtime.runtimeID, storage: runtime.storage }
                : { kind: "attached" }
          const child = (() => {
            try {
              return Bun.spawn(args, { stdin: new Blob([JSON.stringify(context)]), stdout: "ignore", stderr: "ignore" })
            } catch {
              return undefined
            }
          })()
          if (!child) continue
          const timeout = setTimeout(() => child.kill(), 2000)
          await child.exited.catch(() => undefined)
          clearTimeout(timeout)
        }
      } finally {
        state.running = false
      }
    })()
  }
}

export * as TerminalSession from "./terminal-session"
