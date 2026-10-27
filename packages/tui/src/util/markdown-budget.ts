// OpenTUI 0.5 uses one process-wide table of 65,535 native handles. A text
// renderable consumes several entries (buffer, view, syntax style, measure
// target), so a message-count window alone cannot bound a dense table/list.
const LIMIT = 12_000

export function markdownCost(content: string) {
  let cost = 32
  let fence: string | undefined
  // Consecutive prose lines become one text renderable, so only the first line
  // of a paragraph is charged. Charging every line made an ordinary long answer
  // cost more than a dense table, which pushed whole sessions onto the plain
  // fallback and left the transcript colorless.
  let paragraph = false
  for (const line of content.split(/\r\n?|\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    const marker = match?.[1]
    if (marker) {
      if (!fence && !(marker[0] === "`" && match[2].includes("`"))) {
        fence = marker
        paragraph = false
        cost += 32
        continue
      }
      if (fence && marker[0] === fence[0] && marker.length >= fence.length && !match[2].trim()) {
        fence = undefined
        continue
      }
    }
    if (fence || !line.trim()) {
      paragraph = false
      continue
    }
    // Deliberately overestimate: cells/list rows can each own multiple text
    // renderables, while ordinary prose and fenced code coalesce cheaply.
    const pipes = line.match(/[>|]/g)?.length ?? 0
    const items = line.match(/(?:[-*+]|\d+[.)])\s/g)?.length ?? 0
    if (pipes + items > 0) {
      paragraph = false
      cost += 16 + pipes * 16 + items * 32
      continue
    }
    if (paragraph) continue
    paragraph = true
    cost += 16
  }
  return cost
}

type Lease = { id: number; cost: number; notify: (rich: boolean) => void }

/**
 * The pool is handed out newest-first.
 *
 * The transcript mounts oldest-first, and the first-come pool that used to back
 * this component therefore spent every handle on the messages the reader had
 * already scrolled past; the answer being streamed at the bottom was the one
 * that went colorless. Leases register their cost instead of taking handles, and
 * one pass after the mount burst assigns the pool from the newest message
 * backwards. Assignments are absolute, so a message that loses the pool never
 * destroys and rebuilds its renderables in a fight with its neighbour.
 */
export function createMarkdownBudget(limit = LIMIT) {
  let next = 0
  let scheduled = false
  const leases = new Map<number, Lease>()
  const assign = () => {
    scheduled = false
    const ordered = [...leases.values()].sort((a, b) => b.id - a.id)
    const granted = new Set<number>()
    let used = 0
    for (const lease of ordered) {
      if (used + lease.cost > limit) continue
      used += lease.cost
      granted.add(lease.id)
    }
    for (const lease of leases.values()) lease.notify(granted.has(lease.id))
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(assign)
  }
  return {
    /**
     * Registers one message. `notify` is called with the assignment every time
     * the pool changes; it must be a signal setter, so a plain message can be
     * upgraded to rich Markdown without a rebuild loop.
     */
    lease(cost: number, notify: (rich: boolean) => void) {
      const id = next++
      leases.set(id, { id, cost, notify })
      schedule()
      return {
        update(nextCost: number) {
          const lease = leases.get(id)
          if (lease === undefined || lease.cost === nextCost) return
          leases.set(id, { id, cost: nextCost, notify })
          schedule()
        },
        release() {
          if (!leases.delete(id)) return
          schedule()
        },
      }
    },
  }
}
