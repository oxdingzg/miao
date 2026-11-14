export * as Cron from "./cron"

import { Schema } from "effect"

/**
 * Pure, synchronous standard 5-field cron parsing and next-fire computation in
 * the local system time zone. Kept free of Effect so scheduling can be reasoned
 * about, and tested, without a runtime.
 */

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("Cron.ParseError", {
  expression: Schema.String,
  message: Schema.String,
}) {}

/** A parsed expression: the allowed values per field, ascending and deduplicated. */
export type Parsed = {
  readonly minute: ReadonlyArray<number>
  readonly hour: ReadonlyArray<number>
  readonly dayOfMonth: ReadonlyArray<number>
  readonly month: ReadonlyArray<number>
  /** Sunday is 0; a literal 7 is normalized to 0 at parse time. */
  readonly dayOfWeek: ReadonlyArray<number>
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

type Field = {
  readonly name: string
  readonly min: number
  readonly max: number
  /** Remaps a parsed member; cron accepts both 0 and 7 for Sunday. */
  readonly normalize?: (value: number) => number
}

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) },
]

/**
 * Four years of days. Bounds the search so an expression that can never match,
 * such as `0 0 31 2 *`, terminates instead of walking forever.
 */
const MAX_DAYS = 4 * 366 + 1

const NUMBER = /^\d+$/

const ascending = (values: Iterable<number>) => [...new Set(values)].toSorted((a, b) => a - b)

function readNumber(raw: string, min: number, max: number, name: string, expression: string): number | ParseError {
  if (!NUMBER.test(raw)) return new ParseError({ expression, message: `${name} is not a number: ${raw}` })
  const value = Number(raw)
  if (value < min || value > max)
    return new ParseError({ expression, message: `${name} is out of range (${min}-${max}): ${raw}` })
  return value
}

/** Parses one comma-separated field into its allowed values, or a typed error. */
function parseField(raw: string, field: Field, expression: string): ReadonlyArray<number> | ParseError {
  const member = (value: number) => (field.normalize ? field.normalize(value) : value)
  const values: number[] = []
  for (const item of raw.split(",")) {
    const [range, stepText, ...extra] = item.split("/")
    if (extra.length > 0 || range === undefined || range === "")
      return new ParseError({ expression, message: `${field.name} has an invalid element: ${item}` })
    const step = stepText === undefined ? 1 : readNumber(stepText, 1, field.max, `${field.name} step`, expression)
    if (step instanceof ParseError) return step
    if (range === "*") {
      for (let value = field.min; value <= field.max; value += step) values.push(member(value))
      continue
    }
    const [startText, endText, ...rest] = range.split("-")
    if (rest.length > 0 || startText === undefined || startText === "")
      return new ParseError({ expression, message: `${field.name} has an invalid element: ${item}` })
    const start = readNumber(startText, field.min, field.max, field.name, expression)
    if (start instanceof ParseError) return start
    if (endText === undefined) {
      if (stepText !== undefined)
        return new ParseError({ expression, message: `${field.name} needs a range for a step: ${item}` })
      values.push(member(start))
      continue
    }
    const end = readNumber(endText, field.min, field.max, field.name, expression)
    if (end instanceof ParseError) return end
    if (start > end) return new ParseError({ expression, message: `${field.name} range is reversed: ${item}` })
    for (let value = start; value <= end; value += step) values.push(member(value))
  }
  return ascending(values)
}

/** Parses a 5-field expression, or returns a typed error describing the fault. */
export function parse(expression: string): Parsed | ParseError {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5)
    return new ParseError({
      expression,
      message: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.`,
    })
  const parsed: ReadonlyArray<number>[] = []
  for (const [index, field] of FIELDS.entries()) {
    const values = parseField(fields[index]!, field, expression)
    if (values instanceof ParseError) return values
    parsed.push(values)
  }
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
    // A field is restricted unless it is exactly "*", matching the standard
    // day-of-month/day-of-week OR rule.
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  }
}

function dayMatches(parsed: Parsed, date: Date): boolean {
  if (!parsed.month.includes(date.getMonth() + 1)) return false
  const dayOfMonth = parsed.dayOfMonth.includes(date.getDate())
  const dayOfWeek = parsed.dayOfWeek.includes(date.getDay())
  // Standard cron: with both day fields restricted, either one may match.
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return dayOfMonth || dayOfWeek
  return dayOfMonth && dayOfWeek
}

/**
 * The next local-time fire strictly after `fromMillis`, or `undefined` when the
 * expression cannot match within the bounded search. An unparseable expression
 * also returns `undefined`; use `parse` when a typed error is required.
 */
export function next(expression: string | Parsed, fromMillis: number): number | undefined {
  const parsed = typeof expression === "string" ? parse(expression) : expression
  if (parsed instanceof ParseError) return undefined
  const start = new Date(fromMillis)
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  for (let index = 0; index < MAX_DAYS; index++) {
    if (dayMatches(parsed, day)) {
      for (const hour of parsed.hour) {
        for (const minute of parsed.minute) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime()
          if (candidate > fromMillis) return candidate
        }
      }
    }
    // Rebuild from calendar parts so month/year rollovers and DST are handled.
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return undefined
}
