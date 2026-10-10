export * as BlackboxCompare from "./compare"

import { Schema } from "effect"
import { BlackboxTape } from "./tape"

export type Difference = { path: string; expected: Schema.Json | undefined; actual: Schema.Json | undefined }

/** Report the earliest structural difference. No fuzzy matching, dropped array
 * elements, or blanket ID/time removal can hide a context or tool regression. */
export function difference(
  expected: Schema.Json | undefined,
  actual: Schema.Json | undefined,
  path = "$",
): Difference | undefined {
  if (expected === actual) return undefined
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      const found = difference(expected[index], actual[index], `${path}[${index}]`)
      if (found) return found
    }
    return undefined
  }
  if (BlackboxTape.isObject(expected) && BlackboxTape.isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const found = difference(expected[key], actual[key], `${path}.${key}`)
      if (found) return found
    }
    return undefined
  }
  return { path, expected, actual }
}

export type Report =
  | { equal: true; interactions: number; traceEvents: number }
  | { equal: false; channel: "interaction" | "trace"; lane: string; ordinal: number; difference: Difference }

/** Lanes preserve causal order while unrelated Sessions may interleave. Timing
 * measures performance and is retained in the bundle, not equated to behavior.
 * Trace recording times are compared only when explicitly requested. */
export function compare(
  expected: BlackboxTape.Bundle,
  actual: BlackboxTape.Bundle,
  options: { recordedTime?: boolean } = {},
): Report {
  const lanes = [...new Set([...expected.interactions, ...actual.interactions].map((item) => item.lane))].sort()
  for (const lane of lanes) {
    const left = expected.interactions.filter((item) => item.lane === lane)
    const right = actual.interactions.filter((item) => item.lane === lane)
    for (let ordinal = 0; ordinal < Math.max(left.length, right.length); ordinal++) {
      const semantic = (item: BlackboxTape.Interaction | undefined) =>
        item === undefined
          ? undefined
          : BlackboxTape.json({
              request: item.request,
              frames: item.frames.map((frame) => frame.value),
              outcome: item.outcome,
              ...(item.error === undefined ? {} : { error: item.error }),
            })
      const found = difference(semantic(left[ordinal]), semantic(right[ordinal]))
      if (found) return { equal: false, channel: "interaction", lane, ordinal, difference: found }
    }
  }
  const sessions = [...new Set([...expected.trace, ...actual.trace].map((item) => item.session))].sort()
  for (const session of sessions) {
    const left = expected.trace.filter((item) => item.session === session)
    const right = actual.trace.filter((item) => item.session === session)
    for (let ordinal = 0; ordinal < Math.max(left.length, right.length); ordinal++) {
      const semantic = (item: BlackboxTape.Trace | undefined) =>
        item === undefined
          ? undefined
          : BlackboxTape.json({
              kind: item.kind,
              data: item.data,
              ...(options.recordedTime ? { recordedAtMs: item.recordedAtMs } : {}),
            })
      const found = difference(semantic(left[ordinal]), semantic(right[ordinal]))
      if (found) return { equal: false, channel: "trace", lane: session, ordinal, difference: found }
    }
  }
  return { equal: true, interactions: expected.interactions.length, traceEvents: expected.trace.length }
}
