export * as ConfigDiagnostics from "./diagnostics"

import { Schema } from "effect"
import { Info } from "@miao/schema/config"

/**
 * One problem a strict decode found in a configuration document. Loading
 * stays tolerant — an unknown key never stops a location from opening — but it
 * is no longer silent: every refusal names the document, the key path and the
 * value that was ignored.
 */
export interface Diagnostic {
  /** A key the schema does not accept, a required key that is absent, or a value of the wrong shape. */
  readonly kind: "unknown-key" | "missing-key" | "invalid-value"
  /** Key path segments pointing at the offending key. */
  readonly path: readonly string[]
  /** The ignored value, for unknown keys. */
  readonly value?: unknown
  /** The closest key this document's siblings use, when one is close enough to be a likely typo. */
  readonly suggestion?: string
  readonly message: string
}

const strictDecode = Schema.decodeUnknownSync(Info, { errors: "all", onExcessProperty: "error" })

/**
 * Strict probe of one document. The tolerant decode in `Config` stays
 * authoritative; this only reads the decoder's failure message, which carries
 * each offending key path in a stable shape:
 *
 *     Unexpected key with value 1
 *       at ["modell"]
 *     Expected string | undefined, got 123
 *       at ["model"]
 *
 * The decoder reports failures by throwing, so the throw is contained here and
 * never escapes this function.
 */
export function of(input: unknown): Diagnostic[] {
  try {
    strictDecode(input)
    return []
  } catch (error) {
    // A schema refusal is a `SchemaError` value rather than an `Error`
    // subclass, and its `message` already is the multi-line report; stringifying
    // it instead would wrap that report in `SchemaError(...)` and hide the
    // shape the parser reads.
    const message = (error as { message?: unknown }).message
    return parse(typeof message === "string" ? message : String(error))
  }
}

/** Turns a strict-decode failure message back into structured diagnostics. */
export function parse(message: string): Diagnostic[] {
  const segments = message.split("\n")
  const diagnostics: Diagnostic[] = []
  for (let index = 0; index < segments.length; index++) {
    const description = segments[index]!.trimEnd()
    const location = segments[index + 1]
    if (location === undefined || !location.trimStart().startsWith("at [")) continue
    index += 1
    const path = pathOf(location)
    if (description.startsWith("Unexpected key with value "))
      diagnostics.push({ kind: "unknown-key", path, value: ignored(description.slice(25)), message: description })
    else if (description === "Missing key") diagnostics.push({ kind: "missing-key", path, message: description })
    else diagnostics.push({ kind: "invalid-value", path, message: description })
  }
  return diagnostics
}

/** Closest candidate key by edit distance, for keys close enough to be a typo. */
export function suggest(key: string, candidates: readonly string[]): string | undefined {
  const ranked = candidates
    .filter((candidate) => candidate !== key)
    .map((candidate) => ({ candidate, distance: distance(key, candidate) }))
    .filter((entry) => entry.distance <= 2)
    .sort((left, right) => left.distance - right.distance)
  return ranked[0]?.candidate
}

const segment = /\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/g

/** Reads the key path out of one `at [...]` line, unescaping quoted names. */
const pathOf = (line: string): string[] =>
  [...line.matchAll(segment)].map((match) => (match[1] === undefined ? match[2]! : JSON.parse(`"${match[1]}"`)))

/** The ignored value as JSON, falling back to the raw text if the decoder truncated it. */
const ignored = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const distance = (from: string, to: string): number => {
  const row = Array.from({ length: to.length + 1 }, (_, index) => index)
  for (let left = 1; left <= from.length; left++) {
    let diagonal = row[0]!
    row[0] = left
    for (let right = 1; right <= to.length; right++) {
      const above = row[right]!
      row[right] = Math.min(row[right]! + 1, row[right - 1]! + 1, diagonal + (from[left - 1] === to[right - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[to.length]!
}
