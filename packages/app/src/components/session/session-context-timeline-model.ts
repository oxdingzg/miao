import type { SessionsUsageHistoryOutput } from "@miao/client"
import type { SessionMessageInfo } from "@/utils/server"

export type UsageStep = SessionsUsageHistoryOutput["items"][number]

export function contextTimeline(
  steps: readonly UsageStep[],
  messages: readonly SessionMessageInfo[],
  catalog: ReadonlyMap<string, number>,
) {
  const records = new Map(messages.map((message) => [message.id, message]))
  const last = new Map(steps.map((step) => [step.messageID, step.id]))
  const compacted = messages.flatMap((message) =>
    message.type === "compaction" && message.time.created !== null ? [message.time.created] : [],
  )
  const points = steps.map((step, index) => {
    const message = records.get(step.messageID)
    // A message retains only its latest sending budget. Earlier provider steps
    // must not inherit that measurement, even when they share the message ID.
    const measured =
      message?.type === "assistant" &&
      last.get(step.messageID) === step.id &&
      message.model?.id === step.model.id &&
      message.model.providerID === step.model.providerID
        ? message.contextBudget?.window
        : undefined
    const current = catalog.get(JSON.stringify([step.model.providerID, step.model.id]))
    const window =
      measured !== undefined && measured > 0 ? measured : current !== undefined && current > 0 ? current : undefined
    return {
      ...step,
      input:
        Math.max(0, step.tokens.input) + Math.max(0, step.tokens.cache.read) + Math.max(0, step.tokens.cache.write),
      window,
      source: measured !== undefined && measured > 0 ? ("request" as const) : window ? ("catalog" as const) : undefined,
      compacted: compacted.some((time) => time > (steps[index - 1]?.time ?? -Infinity) && time <= step.time),
    }
  })
  const segments: {
    key: string
    points: typeof points
    window?: number
    source?: "request" | "catalog"
    axis: number
  }[] = []
  for (const point of points) {
    const key = JSON.stringify([point.model.providerID, point.model.id, point.window])
    const previous = segments.at(-1)
    if (previous?.key === key) {
      previous.points.push(point)
      if (point.source === "catalog") previous.source = "catalog"
      continue
    }
    segments.push({ key, points: [point], window: point.window, source: point.source, axis: 1 })
  }
  return segments.map((segment) => {
    const peak = Math.max(1, ...segment.points.map((point) => point.input))
    return { ...segment, axis: segment.window && segment.window <= peak * 1.25 ? Math.max(peak, segment.window) : peak }
  })
}
