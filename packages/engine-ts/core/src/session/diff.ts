export * as SessionDiff from "./diff"

export interface RecordedEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * The earliest captured filesystem snapshot recorded for a Session, used as the
 * diff baseline. Snapshots are attached to `session.next.step.started` events.
 */
export const baselineSnapshot = (events: ReadonlyArray<RecordedEvent>): string | undefined => {
  for (const event of events) {
    if (event.type !== "session.next.step.started") continue
    const data = event.data
    if (typeof data !== "object" || data === null) continue
    const snapshot = (data as { snapshot?: unknown }).snapshot
    if (typeof snapshot === "string") return snapshot
  }
  return undefined
}

/**
 * Snapshots bounding one user turn, matching V1's per-message `summary.diffs`:
 * from the first step start after the user message was prompted to the last
 * step end before the next prompted message. `to` is undefined while the turn
 * has not finished a step; the caller then diffs against the live worktree.
 */
export const turnSnapshots = (
  events: ReadonlyArray<RecordedEvent>,
  messageID: string,
): { readonly from: string; readonly to: string | undefined } | undefined => {
  const bounds = events.reduce<{ inTurn: boolean; done: boolean; from?: string; to?: string }>(
    (state, event) => {
      if (state.done) return state
      const data = typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : {}
      if (event.type === "session.next.prompted")
        return state.inTurn ? { ...state, done: true } : { ...state, inTurn: data.messageID === messageID }
      if (!state.inTurn || typeof data.snapshot !== "string") return state
      if (event.type === "session.next.step.started" && state.from === undefined)
        return { ...state, from: data.snapshot }
      if (event.type === "session.next.step.ended") return { ...state, to: data.snapshot }
      return state
    },
    { inTurn: false, done: false },
  )
  return bounds.from === undefined ? undefined : { from: bounds.from, to: bounds.to }
}
