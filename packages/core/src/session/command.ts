export * as SessionCommand from "./command"

const PLACEHOLDER = /\$(\d+)/g
const ARGS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const QUOTE_TRIM = /^["']|["']$/g

/**
 * Renders a slash-command template with positional (`$1`, `$2`, ...) and
 * `$ARGUMENTS` placeholders, matching V1 semantics: the highest positional
 * placeholder captures the remaining arguments, and a template with no
 * placeholder appends the raw arguments as a trailing paragraph.
 */
export const renderTemplate = (template: string, arguments_: string): string => {
  const raw = arguments_.match(ARGS) ?? []
  const args = raw.map((arg) => arg.replace(QUOTE_TRIM, ""))
  const placeholders = template.match(PLACEHOLDER) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }
  const withArgs = template.replace(PLACEHOLDER, (_match, index: string) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })
  const usesArguments = template.includes("$ARGUMENTS")
  let result = withArgs.replaceAll("$ARGUMENTS", arguments_)
  if (placeholders.length === 0 && !usesArguments && arguments_.trim()) result = `${result}\n\n${arguments_}`
  return result.trim()
}
