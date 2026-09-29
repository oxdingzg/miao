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
