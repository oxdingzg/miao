import type { Message, Part } from "@miao/schema/view-models"

export function waitingForResponse(input: { busy: boolean; blocked: boolean; message?: Message; parts: Part[] }) {
  if (!input.busy || input.blocked) return false
  if (!input.message || input.message.role === "user" || input.message.time.completed !== undefined) return true
  return !input.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
    return part.type === "tool"
  })
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

  async function poll() {
    await Promise.resolve()
      .then(() => (disposed ? undefined : input.read()))
      .then((status) => {
        if (disposed || status === undefined) return
        last = status
        input.onStatus?.(status)
      })
      .catch((error: unknown) => {
        if (!disposed) input.onError(error)
      })
    // An idle session changes execution ownership rarely, and under Bun every
    // timer wakeup allocates (a JSC eden collection), so poll far less often
    // when idle. A busy — or still unknown after a failed read — one keeps the
    // close cadence so a prompt idle flip and error recovery stay responsive.
    const interval = last === "idle" ? (input.idleInterval ?? 5000) : (input.interval ?? 1000)
    if (!disposed) timer = setTimeout(() => void poll(), interval)
  }

  void poll()
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
  }
}
