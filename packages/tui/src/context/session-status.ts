import type { Message, Part } from "@miao/schema/view-models"
import type { SessionStatus } from "@miao/schema/view-models"

export type SessionPhase = "queued" | "preparing" | "requesting" | "streaming" | "retrying"

/**
 * Normalizes a status to its phase. `retry` is the `retrying` phase, and a busy
 * status with no phase (an optimistic write or an older producer) reads as
 * `preparing`.
 */
export function statusPhase(status: SessionStatus | undefined): SessionPhase | undefined {
  if (!status || status.type === "idle") return undefined
  if (status.type === "retry") return "retrying"
  return status.phase ?? "preparing"
}

export function waitingForResponse(input: { busy: boolean; blocked: boolean; message?: Message; parts: Part[] }) {
  if (!input.busy || input.blocked) return false
  if (!input.message || input.message.role === "user" || input.message.time.completed !== undefined) return true
  return !input.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
    return part.type === "tool"
  })
}

/**
 * Idle polls back off 1x, 2x, 4x, then 6x the idle cadence. Live events
 * already refresh the status eagerly, so the poll is a safety net for missed
 * events; growing its cadence keeps early flips responsive while cutting the
 * steady-state wakeups of a session that stays idle for hours.
 */
export function idlePollInterval(base: number, idleStreak: number) {
  return Math.min(base * 2 ** Math.min(idleStreak, 3), base * 6)
}

// Poll execution ownership rather than inferring it from the last transcript
// message: provider TTFT has no content events, and interruption may leave a user
// message last. Keep one request in flight and ignore replies after disposal.
export function watchSessionStatus(input: {
  read: () => Promise<"busy" | "idle">
  onStatus?: (status: "busy" | "idle") => void
  onError: (error: unknown) => void
  interval?: number
  idleInterval?: number
}) {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: "busy" | "idle" | undefined
  let idleStreak = 0

  async function poll() {
    await Promise.resolve()
      .then(() => (disposed ? undefined : input.read()))
      .then((status) => {
        if (disposed || status === undefined) return
        if (status !== last) idleStreak = 0
        else if (status === "idle") idleStreak += 1
        last = status
        input.onStatus?.(status)
      })
      .catch((error: unknown) => {
        if (!disposed) input.onError(error)
      })
    // An idle session changes execution ownership rarely, and under Bun every
    // timer wakeup allocates (a JSC eden collection), so poll on a growing
    // cadence when idle. A busy — or still unknown after a failed read — one
    // keeps the close cadence so a prompt idle flip and error recovery stay
    // responsive.
    const base = last === "idle" ? (input.idleInterval ?? 5000) : (input.interval ?? 1000)
    const interval = last === "idle" ? idlePollInterval(base, idleStreak) : base
    if (!disposed) timer = setTimeout(() => void poll(), interval)
  }

  void poll()
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
  }
}
