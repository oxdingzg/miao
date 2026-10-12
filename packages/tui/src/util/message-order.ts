/** Unknown clocks cannot establish chronology; retain the source cursor order. */
export function chronological<T extends { id: string; time: { created: number | null } }>(messages: readonly T[]): T[] {
  if (messages.some((message) => message.time.created === null)) return messages.slice()
  return messages.toSorted((a, b) => {
    if (a.time.created === null || b.time.created === null) return 0
    return a.time.created - b.time.created || a.id.localeCompare(b.id)
  })
}
