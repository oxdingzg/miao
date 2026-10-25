import { isRecord } from "../util/record"

/** Retry one prompt ID; the server reconciles admission and lost HTTP receipts. */
export async function retryPromptSend<T>(input: {
  /** Shutdown signal. Its abort cancels the send and is not a transport failure. */
  signal?: AbortSignal
  prepare?: (signal: AbortSignal | undefined, attempt: number) => Promise<void>
  send: (signal: AbortSignal | undefined, attempt: number) => Promise<T>
  received: () => boolean
  retry: (error: unknown, attempt: number) => void
}) {
  const delays = [250, 750, 1500]
  // Admission is a durable, idempotent write that the event stream also
  // confirms, so the request carries no client deadline. A timeout on a slow
  // but valid admission aborts work the server has already accepted and
  // resends it, turning latency into a retry storm.
  const stopped = () => input.received() || input.signal?.aborted === true
  for (let attempt = 0; ; attempt++) {
    if (stopped()) return
    try {
      await input.prepare?.(input.signal, attempt)
      if (stopped()) return
      return await input.send(input.signal, attempt)
    } catch (error) {
      if (stopped()) return
      if (!isRecord(error) || error.reason !== "Transport" || attempt >= delays.length) throw error
      input.retry(error, attempt + 1)
      await Bun.sleep(delays[attempt])
    }
  }
}
