import type { Event } from "@opencode-ai/sdk/v2"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

// miao-term's terminal, mtty (named miaotty up to v0.0.5), spawns every pane
// with MTTY_PANE_ID and MTTY_CLI set (and, during the rename, the MIAOTTY_*
// names too). When we detect that environment we report the agent state so the
// terminal can badge the pane, deliver queued prompts and drive notifications.
// Outside the terminal this plugin is a no-op.

export const MIAOTTY_STATES = ["idle", "processing", "awaiting", "error"] as const
export type MiaottyState = (typeof MIAOTTY_STATES)[number]

// Maps miao events to the small state vocabulary miaotty understands. Kept as a
// pure reducer so it can be tested without spawning anything.
export function createMiaottyStateTracker() {
  const active = new Set<string>()
  const pending = new Set<string>()
  const errored = new Set<string>()
  let current: MiaottyState = "idle"

  function derive(): MiaottyState {
    if (pending.size > 0) return "awaiting"
    if (active.size > 0) return "processing"
    if (errored.size > 0) return "error"
    return "idle"
  }

  return {
    get current() {
      return current
    },
    handle(event: Event): MiaottyState | undefined {
      switch (event.type) {
        case "session.status": {
          const sessionID = event.properties.sessionID
          if (event.properties.status.type === "idle") active.delete(sessionID)
          else {
            active.add(sessionID)
            errored.delete(sessionID)
          }
          break
        }
        case "session.idle": {
          active.delete(event.properties.sessionID)
          break
        }
        case "session.error": {
          const sessionID = event.properties.sessionID
          if (sessionID) {
            active.delete(sessionID)
            errored.add(sessionID)
          }
          break
        }
        case "question.asked":
        case "question.v2.asked":
        case "permission.asked":
        case "permission.v2.asked": {
          pending.add(event.properties.id)
          break
        }
        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "permission.replied":
        case "permission.v2.replied": {
          pending.delete(event.properties.requestID)
          break
        }
        default:
          return undefined
      }

      const next = derive()
      if (next === current) return undefined
      current = next
      return next
    },
  }
}

// The pane to report for and the CLI that reaches the terminal, preferring the
// mtty names. An older miaotty host sets only MIAOTTY_PANE_ID, and its CLI is
// `miaotty-cli`.
export function terminalTarget(env: Record<string, string | undefined>) {
  const pane = env.MTTY_PANE_ID || env.MIAOTTY_PANE_ID
  if (!pane) return undefined
  const exe = env.MTTY_CLI || env.MIAOTTY_CLI || (env.MTTY_PANE_ID ? "mtty-cli" : "miaotty-cli")
  return { pane, exe }
}

function report(pane: string, exe: string, state: MiaottyState) {
  if (typeof Bun === "undefined") return
  try {
    const child = Bun.spawn([exe, "state", "miao", "--state", state, "--pane", pane], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    void child.exited.catch(() => {})
  } catch {
    // The terminal's CLI is not reachable; nothing to report to.
  }
}

export const MiaottyPlugin: Plugin = async () => {
  const target = terminalTarget(process.env)
  if (!target) return {}
  const { pane, exe } = target
  const tracker = createMiaottyStateTracker()

  report(pane, exe, tracker.current)

  const hooks: Hooks = {
    event: async ({ event }) => {
      const next = tracker.handle(event as unknown as Event)
      if (next) report(pane, exe, next)
    },
  }
  return hooks
}

export * as Miaotty from "./miaotty"
