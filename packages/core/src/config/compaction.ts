export { ConfigCompaction } from "@miao/schema/config/compaction"

import { ConfigCompaction } from "@miao/schema/config/compaction"
import { Token } from "../util/token"
import { Wildcard } from "../util/wildcard"

export type MaxContext = ConfigCompaction.Budget | Readonly<Record<string, ConfigCompaction.Budget>>

/**
 * Resolve `compaction.max_context` to the window one model should work in, or
 * undefined to keep the model's own window. A scalar applies to every model; a
 * map is keyed by "<providerID>/<modelID>" with globs, longest key wins.
 */
export const maxContext = (input: {
  readonly configured: MaxContext | undefined
  readonly provider: string
  readonly model: string
  readonly context: number
}): number | undefined => {
  const configured = input.configured
  if (configured === undefined || input.context <= 0) return undefined
  const raw = typeof configured === "object" ? Wildcard.all(`${input.provider}/${input.model}`, configured) : configured
  if (raw === undefined || raw === "") return undefined
  const parsed = Token.parseQuantity(raw, input.context)
  // 0 restores the model default: a config merge cannot delete a map key. A
  // value at or above the window is a no-op, so the window stays attributable
  // to the model rather than to the setting.
  if (parsed === undefined || parsed === 0 || parsed >= input.context) return undefined
  return parsed
}
