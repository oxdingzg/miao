import { isRecord } from "../util/record"

/** Retry one prompt ID; the server reconciles admission and lost HTTP receipts. */
export async function retryPromptSend<T>(input: {
  send: (signal: AbortSignal, attempt: number) => Promise<T>
  received: () => boolean
  retry: (error: unknown, attempt: number) => void
}) {
  const delays = [250, 750, 1500]
  for (let attempt = 0; ; attempt++) {
    if (input.received()) return
    try {
      return await input.send(AbortSignal.timeout(10_000), attempt)
    } catch (error) {
      if (input.received()) return
      if (!isRecord(error) || error.reason !== "Transport" || attempt >= delays.length) throw error
      input.retry(error, attempt + 1)
      await Bun.sleep(delays[attempt])
    }
  }
}
