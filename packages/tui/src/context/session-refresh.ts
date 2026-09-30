// Bound refresh frequency without waiting for the stream to go quiet. Events
// during a fetch require a follow-up fetch, not another observer of its result.
export function createSessionRefreshScheduler(input: {
  refresh: (sessionID: string) => Promise<void>
  onError: (error: unknown) => void
  delay?: number
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const pending = new Set<string>()
  let disposed = false

  function schedule(sessionID: string) {
    if (disposed) return
    pending.add(sessionID)
    if (timers.has(sessionID) || running.has(sessionID)) return
    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID)
        pending.delete(sessionID)
        running.add(sessionID)
        void Promise.resolve()
          .then(() => input.refresh(sessionID))
          .catch(input.onError)
          .finally(() => {
            running.delete(sessionID)
            if (pending.has(sessionID)) schedule(sessionID)
          })
      }, input.delay ?? 200),
    )
  }

  return {
    schedule,
    dispose() {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
  }
}
