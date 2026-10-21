import path from "path"
import { DiagnosticFiles } from "@miao/core/diagnostic-files"
import { Global } from "@miao/core/global"
import { isNativeResourceError } from "../util/native-resource-error"
import { catchError, createMemo, createSignal, untrack, type JSX } from "solid-js"

/** What the crash screen needs to describe a failure. */
export type CrashReport = {
  /** The first error handled for this subtree: the one that actually broke it. */
  error: Error
  /** Errors handled after the first, usually cascades of it. */
  following: readonly Error[]
  /** How many errors were handled in total, including any beyond `following`. */
  count: number
}

// Solid's own ErrorBoundary hands its fallback only the most recent handled
// error. A memo whose computation failed keeps its previous value — undefined on
// the first run — and never rethrows that failure; every later read of it fails
// one property access further out instead. The boundary therefore ends up
// reporting the outermost link of a cascade (`undefined is not an object
// (evaluating 'actionItems().indexOf')`) while the error that actually broke the
// subtree is thrown away. Keep the first error so the crash screen names it, and
// record what followed so the report shows how far it spread.
const Recorded = 16

export function ErrorBoundary(props: {
  fallback: (report: CrashReport, reset: () => void) => JSX.Element
  onNativeResourceError?: (report: CrashReport) => void
  children: JSX.Element
}): JSX.Element {
  const collected: Error[] = []
  let count = 0
  let settled = false
  let nativeFailureReported = false
  const [report, setReport] = createSignal<CrashReport>()
  const snapshot = (): CrashReport => ({ error: collected[0], following: collected.slice(1), count })
  const reset = () => {
    collected.length = 0
    count = 0
    settled = false
    nativeFailureReported = false
    setReport(undefined)
  }
  const record = (value: unknown) => {
    const normalized = value instanceof Error ? value : new Error(typeof value === "string" ? value : "Unknown error")
    count += 1
    if (collected.length < Recorded) collected.push(normalized)
    recordCrash(normalized, count === 1)
    if (count === 1) setReport(snapshot())
    else if (!settled) {
      // The screen already shows the first error; refresh it once with the full
      // cascade after the error being handled finishes propagating. Writing to
      // the report from inside the propagation re-enters the failing subtree
      // instead and keeps it producing errors forever.
      settled = true
      queueMicrotask(() => setReport(snapshot()))
    }
  }

  // Solid's own ErrorBoundary returns a memo while typing itself as JSX.Element:
  // the reconciler accepts an accessor and re-renders it when it changes.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- a memo accessor is a valid component return for the reconciler
  return createMemo(() => {
    const current = report()
    if (current) {
      if (props.onNativeResourceError && isNativeResourceError(current.error)) {
        if (!nativeFailureReported) {
          nativeFailureReported = true
          untrack(() => props.onNativeResourceError!(current))
        }
        return undefined
      }
      return props.fallback(current, reset)
    }
    return catchError(() => props.children, record)
  }) as unknown as JSX.Element
}

// The TUI thread's console is the in-app console, so a crash record that should
// outlive the session appends to the same diagnostics file as the theme log.
// A failed diagnostic write must not take the crash screen down with it.
function recordCrash(error: Error, first: boolean) {
  const line = `${new Date().toISOString()} pid=${process.pid} crash first=${first} message=${JSON.stringify(error.message)} stack=${JSON.stringify(error.stack ?? "")}\n`
  try {
    DiagnosticFiles.append(path.join(Global.Path.log, "tui.log"), line, DiagnosticFiles.MiB, {
      match: (name) => name === "tui.log" || name === "tui.log.previous",
      maxBytes: 2 * DiagnosticFiles.MiB,
      maxFiles: 2,
    })
  } catch {}
}
