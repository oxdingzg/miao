import { createMemo, createSignal, type Accessor } from "solid-js"

// Window UI nodes, not the transcript store. The full message list remains
// available to timelines, forks and exports; scrolling reveals local history
// before requesting older server pages.
export function createTranscriptWindow<T extends { id: string }>(messages: Accessor<readonly T[]>, pageSize = 40) {
  const [anchor, setAnchor] = createSignal<string>()
  const start = createMemo(() => {
    const id = anchor()
    const index = id === undefined ? -1 : messages().findIndex((message) => message.id === id)
    return index >= 0 ? index : Math.max(0, messages().length - pageSize)
  })
  return {
    start,
    messages: createMemo(() => messages().slice(start())),
    reset: () => setAnchor(undefined),
    pin: () => setAnchor(messages()[start()]?.id),
    reveal(id: string) {
      const index = messages().findIndex((message) => message.id === id)
      if (index < 0 || index >= start()) return false
      setAnchor(id)
      return true
    },
    older() {
      if (start() === 0) return false
      setAnchor(messages()[Math.max(0, start() - pageSize)]?.id)
      return true
    },
  }
}
