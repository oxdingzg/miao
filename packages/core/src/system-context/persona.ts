export * as Persona from "./persona"

import ANTHROPIC from "./persona/anthropic.txt"
import ASTRA from "./persona/gpt-astra.txt"
import BEAST from "./persona/beast.txt"
import CODEX from "./persona/codex.txt"
import DEFAULT from "./persona/default.txt"
import GEMINI from "./persona/gemini.txt"
import GPT from "./persona/gpt.txt"
import KIMI from "./persona/kimi.txt"
import META from "./persona/meta.txt"
import TRINITY from "./persona/trinity.txt"

/** Providers that serve the Moonshot family whatever the model id says. */
const KIMI_PROVIDERS = ["kimi-for-coding", "moonshotai", "moonshotai-cn"]

/**
 * Base system prompt for the model family in use.
 *
 * Families share tool-calling etiquette, so the tuning is keyed on the model
 * rather than the agent: one text serves every provider of the same family.
 * Selection reads the wire-level model id where the catalog publishes one and
 * otherwise the configured model id, which is the only id a plan or gateway
 * provider exposes (for example `deepseek/deepseek-flash`).
 */
export function system(input: {
  readonly providerID?: string
  readonly modelID?: string
  readonly apiID?: string
}): string {
  // Both ids are consulted because either one can name the family, and the
  // family order below is the dispatch order: gpt-4/o1/o3 before gpt, gpt-6
  // and codex before the general gpt text.
  const id = [input.apiID, input.modelID]
    .filter((part): part is string => part !== undefined)
    .join(" ")
    .toLowerCase()
  if (id.includes("muse"))
    return META.replaceAll("{{MODEL_NAME}}", id.includes("muse-glimmer") ? "Muse Glimmer" : "Muse Spark")
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return BEAST
  if (id.includes("gpt")) {
    if (id.includes("gpt-6")) return ASTRA
    if (id.includes("codex")) return CODEX
    return GPT
  }
  if (id.includes("gemini-")) return GEMINI
  if (id.includes("claude")) return ANTHROPIC
  if (id.includes("trinity")) return TRINITY
  if (id.includes("kimi") || KIMI_PROVIDERS.includes(input.providerID ?? "")) return KIMI
  return DEFAULT
}
