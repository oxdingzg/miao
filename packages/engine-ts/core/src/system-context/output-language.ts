export * as OutputLanguage from "./output-language"

/**
 * Anchors every channel the user sees to the user's language. It is a separate
 * system part placed after the context baseline rather than a line near the top
 * of each persona: "respond in the same language" does not cover the reasoning
 * channel miao renders, and a single line in a large English prompt erodes
 * within a turn or two.
 */
export const instruction = [
  "# Output language",
  "",
  "Write in the same language as the user's latest message, everywhere: your reasoning, intermediate progress updates, and the final answer.",
  "Only use English when the user writes in English or explicitly asks for it.",
  "Keep technical terms, code identifiers, file paths, and quoted text in their original form.",
].join("\n")
