const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** A title is OSC payload, so controls must not terminate or restart its sequence. */
export function terminalTitle(input: string) {
  const title = input
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!title) return "miao"
  const chars = Array.from(segments.segment(title), (part) => part.segment)
  return `miao | ${chars.length > 40 ? chars.slice(0, 37).join("") + "…" : title}`
}
