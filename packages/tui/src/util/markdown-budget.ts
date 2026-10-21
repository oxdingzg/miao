// OpenTUI 0.5 uses one process-wide table of 65,535 native handles. A text
// renderable consumes several entries (buffer, view, syntax style, measure
// target), so a message-count window alone cannot bound a dense table/list.
const LIMIT = 12_000

export function markdownCost(content: string) {
  let cost = 32
  let fence: string | undefined
  for (const line of content.split(/\r\n?|\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    const marker = match?.[1]
    if (marker) {
      if (!fence && !(marker[0] === "`" && match![2].includes("`"))) {
        fence = marker
        cost += 32
        continue
      }
      if (fence && marker[0] === fence[0] && marker.length >= fence.length && !match![2].trim()) {
        fence = undefined
        continue
      }
    }
    if (fence || !line.trim()) continue
    // Deliberately overestimate: cells/list rows can each own multiple text
    // renderables, while ordinary prose and fenced code coalesce cheaply.
    cost += 16 + (line.match(/[>|]/g)?.length ?? 0) * 16
    cost += (line.match(/(?:[-*+]|\d+[.)])\s/g)?.length ?? 0) * 32
  }
  return cost
}

export function createMarkdownBudget(limit = LIMIT) {
  let used = 0
  return {
    lease() {
      let held = 0
      return {
        reserve(cost: number) {
          const next = used - held + cost
          used -= held
          held = 0
          if (next > limit) return false
          used += cost
          held = cost
          return true
        },
        release() {
          used -= held
          held = 0
        },
      }
    },
  }
}
