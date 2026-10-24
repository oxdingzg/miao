export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * Value of the longest pattern that matches, ties going to the larger key.
 * Ascending sort plus last-match-wins keeps glob maps predictable: the
 * specific `<provider>/<model>` key beats a `*` catch-all.
 */
export function all<Value>(input: string, patterns: Record<string, Value>): Value | undefined {
  const matched = Object.entries(patterns).filter(([pattern]) => match(input, pattern))
  if (matched.length === 0) return undefined
  matched.sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return matched.at(-1)?.[1]
}
