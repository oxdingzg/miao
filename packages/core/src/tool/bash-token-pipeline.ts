export * as BashTokenPipeline from "./bash-token-pipeline"

import { Flag } from "../flag/flag"

/**
 * Token-efficient post-processing for bash tool output.
 *
 * Tool output is the largest recurring token cost in an agent session, and
 * most of it is noise the model never needed: terminal progress redraws,
 * ANSI styling, secret material the command happened to print, and minified
 * single-line dumps. This module rewrites such output to the minimum that
 * still carries the information, under a hard contract:
 *
 * **Never worse.** If the cleaned text is not strictly shorter than the
 * original, the original is returned unchanged. The pipeline can only save
 * tokens, never spend them, and a bug in a filter cannot corrupt output the
 * model already understands.
 *
 * **Opt-out.** A command containing `# nofilter` or `# raw` skips the
 * pipeline entirely, and MIAO_BASH_RAW=1 disables it globally — when a user
 * is debugging the pipeline itself, or a command's whitespace genuinely
 * matters, the raw bytes stay raw.
 *
 * Stage order matters: progress folding runs before ANSI stripping because
 * `\r` carries state across escape sequences, and redaction runs before line
 * collapsing so a long secret cannot be elided mid-pattern.
 */

const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g
const BACKSPACE = /(?:.\x08)/g
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const REDACT: Array<[RegExp, string]> = [
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1 <redacted>"],
  [/\b(sk|pk)-[A-Za-z0-9_-]{20,}\b/g, "<redacted-key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-github>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-slack>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted-jwt>"],
  [/([?&](?:key|token|password|secret|api_?key)=)[^&\s'"]+/gi, "$1<redacted>"],
  [/\b(AUTH_TOKEN|API_KEY|SECRET|PASSWORD)[ \t]*[=:][ \t]*\S+/gi, "$1=<redacted>"],
]

function stripAnsi(text: string) {
  return text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_DCS, "").replace(BACKSPACE, "").replace(CTRL, "")
}

/** Fold `\r`-redrawn lines (spinners, progress bars) to their last frame. */
function foldProgress(text: string) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const frames = line.split("\r")
      return frames[frames.length - 1]
    })
    .join("\n")
}

function redact(text: string) {
  return REDACT.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
}

function collapseLongLines(text: string) {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= MAX_LINE_CHARS) return line
      return `${line.slice(0, LINE_HEAD_KEEP)}<…${line.length - LINE_HEAD_KEEP} chars elided…>`
    })
    .join("\n")
}

function commandOptsOut(command: string | undefined) {
  return command !== undefined && /(?:^|\s)(?:#\s*(?:nofilter|raw)|\|\s*tee(?:\s|$)|--no-color)/.test(command)
}

export type CleanOptions = {
  /** The shell command that produced the output; `# nofilter`/`# raw` opts out. */
  command?: string
  /** Test hook: override the global raw-output flag. */
  raw?: boolean
}

/**
 * Clean bash output for the model. Returns the input unchanged unless the
 * result is strictly shorter — see the module contract above.
 */
export function clean(output: string, options: CleanOptions = {}): string {
  if (options.raw === true || Flag.MIAO_BASH_RAW === true) return output
  if (commandOptsOut(options.command)) return output
  if (!output) return output
  const cleaned = collapseLongLines(redact(stripAnsi(foldProgress(output))))
  return cleaned.length < output.length ? cleaned : output
}
