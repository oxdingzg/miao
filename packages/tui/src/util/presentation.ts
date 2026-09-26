import { logo } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  const mascot = logo.right.map((line, index) =>
    index === 1 ? `  ${dim}${line}${reset}  ${bold}MIAO${reset}` : `  ${dim}${line}${reset}`,
  )
  return [
    ...mascot,
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}miao -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
