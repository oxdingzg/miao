import { errorMessage } from "./error"

/** A disposed TUI cancels all SDK reads; those rejections are not refresh failures. */
export function backgroundTasks(
  signal: AbortSignal,
  report = (label: string, error: string) => console.error(label, { error }),
) {
  return async (label: string, task: () => Promise<unknown>) => {
    if (signal.aborted) return
    try {
      await task()
    } catch (error) {
      if (!signal.aborted) report(label, errorMessage(error))
    }
  }
}
