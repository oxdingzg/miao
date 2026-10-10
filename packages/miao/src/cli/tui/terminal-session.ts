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
    pending?: { value: Parameters<NonNullable<TuiInput["onSessionChange"]>>[0]; detached: boolean }
    observed?: Parameters<NonNullable<TuiInput["onSessionChange"]>>[0]
    running: boolean
    previous?: string
  } = {
    running: false,
  }
  return (value) => {
    // Closing the observer invalidates live execution, not an already observed
    // terminal outcome. Keep the Session identity and clear only its Runtime
    // binding, so completed work does not turn into an anonymous unknown ring.
    const next =
      value ??
      (state.observed && {
        ...state.observed,
        state: ["completed", "incomplete", "error", "idle"].includes(state.observed.state)
          ? state.observed.state
          : "unknown",
      })
    if (value) state.observed = value
    const signature = JSON.stringify({ value: next ?? null, detached: value === undefined })
    if (signature === state.previous) return
    state.previous = signature
    state.pending = { value: next, detached: value === undefined }
    if (state.running) return
    state.running = true
    void (async () => {
      try {
        while (state.pending) {
          const pending = state.pending
          const next = pending.value
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
            next?.state ?? "unknown",
            "--runtime-context",
            "-",
          ]
          if (next?.sessionID) args.push("--session", next.sessionID)
          if (next?.cwd) args.push("--cwd", next.cwd)
          const context = pending.detached
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
