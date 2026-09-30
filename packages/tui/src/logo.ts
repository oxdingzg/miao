export const logo = {
  left: ["", "", ""],
  right: [" /\\/\\  ", "( o.o )", " > ^ < "],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"

const wordmarkGap = "  "

// Solid-block "MIAO". The installer banner, the exit epilogue and the home banner draw
// these same glyphs, so the art lives here once.
export const wordmark = [
  ["█   █", "█", " ███ ", "█████"],
  ["██ ██", "█", "█   █", "█   █"],
  ["█ █ █", "█", "█████", "█   █"],
  ["█   █", "█", "█   █", "█   █"],
  ["█   █", "█", "█   █", "█████"],
]

// Column range of every letter inside a joined wordmark row, so a renderer can ink them
// one at a time. Derived from the art so the two cannot drift apart.
export const wordmarkColumns = (() => {
  let at = 0
  return wordmark[0].map((letter) => {
    const span = [at, at + letter.length - 1] as const
    at += letter.length + wordmarkGap.length
    return span
  })
})()

// The cat standing beside the wordmark: five rows, the cat on the middle three.
export const banner = {
  left: ["       ", " /\\/\\  ", "( o.o )", " > ^ < ", "       "],
  right: wordmark.map((row) => row.join(wordmarkGap)),
}
