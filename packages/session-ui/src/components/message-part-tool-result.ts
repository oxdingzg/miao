import type { UiI18n, UiI18nPluralKey } from "@miao/ui/context/i18n"

export interface ToolResultInput {
  tool: string
  status?: string
  metadata?: Record<string, any>
  output?: string
}

function countLines(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return 0
  return value.split("\n").length
}

function countItems(value: unknown) {
  return Array.isArray(value) ? value.length : undefined
}

/**
 * The one-line outcome shown under a finished tool call. Only tools whose payload carries a
 * countable result report one; anything else stays silent instead of guessing.
 */
export function toolResultSummary(props: ToolResultInput, i18n: UiI18n) {
  const counted = (key: UiI18nPluralKey, count: number | undefined) => {
    if (count === undefined) return undefined
    return i18n.plural(key, count)
  }
  if (props.status !== "completed") return undefined
  const metadata = props.metadata ?? {}
  switch (props.tool) {
    case "read": {
      // Reading a directory pages entries instead of lines.
      const entries = countItems(metadata.entries)
      if (entries !== undefined) return counted("ui.tool.result.list", entries)
      return counted("ui.tool.result.read", countLines(metadata.content ?? props.output) || undefined)
    }
    case "list":
      return counted("ui.tool.result.list", countItems(metadata.entries))
    case "glob":
      return counted("ui.tool.result.glob", countItems(metadata.value))
    case "grep":
      return counted("ui.tool.result.grep", countItems(metadata.value))
    case "webfetch":
      return counted("ui.tool.result.webfetch", countLines(metadata.output ?? props.output) || undefined)
    default:
      return undefined
  }
}
