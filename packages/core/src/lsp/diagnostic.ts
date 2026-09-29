export * as Diagnostic from "./diagnostic"

/** Minimal LSP diagnostic shape used for model-facing reports. */
export interface Diagnostic {
  readonly severity?: number
  readonly range: { readonly start: { readonly line: number; readonly character: number } }
  readonly message: string
}

const MAX_PER_FILE = 20

const severityName = (severity: number | undefined) => {
  if (severity === 2) return "WARN"
  if (severity === 3) return "INFO"
  if (severity === 4) return "HINT"
  return "ERROR"
}

export function pretty(diagnostic: Diagnostic): string {
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${severityName(diagnostic.severity)} [${line}:${col}] ${diagnostic.message}`
}

/** Renders the report for error-severity diagnostics, or "" when there are none. */
export function report(file: string, issues: readonly Diagnostic[]): string {
  const errors = issues.filter((item) => item.severity === 1 || item.severity === undefined)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, MAX_PER_FILE)
  const more = errors.length - MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}
