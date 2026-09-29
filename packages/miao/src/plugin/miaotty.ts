import type { Event } from "@opencode-ai/sdk/v2"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

// miao-term (the `miaotty` terminal) spawns every pane with MIAOTTY_PANE_ID set
// and ships `miaotty-cli`, which talks to the terminal's control plane. When we
// detect that environment we report the agent state so the terminal can badge
// the pane and drive notifications. Outside miaotty this plugin is a no-op.

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
    // `miaotty-cli` is not reachable; nothing to report to.
  }
}

export const MiaottyPlugin: Plugin = async () => {
  const pane = process.env.MIAOTTY_PANE_ID
  if (!pane) return {}
  const exe = process.env.MIAOTTY_CLI || "miaotty-cli"
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
