export function statusSegments(
  input: {
    model: string
    context: string
    directory: string
    branch?: string
    agent?: string
  },
  width: number,
) {
  const items = [
    {
      key: "model",
      text: input.model,
      min: Math.min(36, Math.max(1, width - Bun.stringWidth(input.context) - 3)),
      max: 56,
    },
    { key: "context", text: input.context, min: Bun.stringWidth(input.context), max: Bun.stringWidth(input.context) },
    { key: "directory", text: input.directory, min: 12, max: 48 },
    ...(input.branch ? [{ key: "branch", text: input.branch, min: 10, max: 28 }] : []),
    ...(input.agent ? [{ key: "agent", text: input.agent, min: 10, max: 24 }] : []),
  ].map((item) => ({
    ...item,
    min: Math.min(item.min, Bun.stringWidth(item.text)),
    max: Math.min(item.max, Bun.stringWidth(item.text)),
  }))
  // Keep the model and context first; drop secondary details before wrapping.
  const shown =
    [items, items.slice(0, 4), items.slice(0, 3), items.slice(0, 2)].find(
      (list) => list.reduce((total, item) => total + item.min, 0) + (list.length - 1) * 3 <= width,
    ) ?? items.slice(0, 1)
  const remaining = width - shown.reduce((total, item) => total + item.min, 0) - (shown.length - 1) * 3
  return shown.reduce<{ remaining: number; items: { key: string; text: string }[] }>(
    (state, item) => {
      const extra = Math.min(Math.max(0, state.remaining), item.max - item.min)
      return {
        remaining: state.remaining - extra,
        items: [
          ...state.items,
          { key: item.key, text: shorten(item.text, Math.min(width, item.min + extra), item.key !== "model") },
        ],
      }
    },
    { remaining, items: [] },
  ).items
}

function shorten(text: string, width: number, preserveEnd: boolean) {
  if (Bun.stringWidth(text) <= width) return text
  if (width < 2) return "…".slice(0, Math.max(0, width))
  const parts = Array.from(new Intl.Segmenter().segment(text), (part) => part.segment)
  if (!preserveEnd) return takeWidth(parts, width - 1).join("") + "…"
  const left = takeWidth(parts, Math.floor((width - 1) / 2))
  const right = takeWidth(parts.toReversed(), width - 1 - Bun.stringWidth(left.join("")))
  return left.join("") + "…" + right.toReversed().join("")
}

function takeWidth(parts: string[], width: number) {
  return parts.reduce<{ width: number; parts: string[] }>(
    (state, part) => {
      const size = state.width + Bun.stringWidth(part)
      return { width: size, parts: size <= width ? [...state.parts, part] : state.parts }
    },
    { width: 0, parts: [] },
  ).parts
}
