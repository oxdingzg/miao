import { logo, wordmark } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

// Cat + solid block "MIAO" (full blocks only, so there is no half-block seam).
// Colors mirror the installer banner: coral cat, warm gradient across MIAO.
const catColor = "\x1b[38;5;210m"
const letterColors = ["\x1b[38;5;209m", "\x1b[38;5;215m", "\x1b[38;5;221m", "\x1b[38;5;226m"]

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  const mascot = wordmark.map((row, index) => {
    const cat = index >= 1 && index <= 3 ? `${catColor}${logo.right[index - 1]}${reset}   ` : "          "
    const word = row.map((glyph, letter) => `${letterColors[letter]}${glyph}${reset}`).join("  ")
    return `${cat}${word}`
  })
  return [
    ...mascot,
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}miao -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
