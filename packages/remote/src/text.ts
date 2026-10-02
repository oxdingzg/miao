/** Splits on code points, preferring a line break in the last fifth of each piece. */
export function split(text: string, limit: number): string[] {
  const characters = [...text]
  if (characters.length <= limit) return [text]
  const window = characters.slice(0, limit)
  const lineBreak = window.lastIndexOf("\n")
  const cut = lineBreak >= limit * 0.8 ? lineBreak + 1 : limit
  return [characters.slice(0, cut).join(""), ...split(characters.slice(cut).join(""), limit)]
}

/** Remembers keys for a while so retransmitted messages are handled once. */
export function deduper(windowMs: number, now: () => number) {
  const seen = new Map<string, number>()
  return (key: string) => {
    const cutoff = now() - windowMs
    seen.forEach((at, entry) => {
      if (at < cutoff) seen.delete(entry)
    })
    if (seen.has(key)) return false
    seen.set(key, now())
    return true
  }
}
