// Session config options (model, effort, mode) built from a Location catalog.
import type { SessionConfigOption } from "@agentclientprotocol/sdk"

/** The effort value meaning "no explicit variant override". */
export const DefaultVariant = "default"

export type CatalogModel = {
  readonly providerID: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  readonly variants: ReadonlyArray<string>
  readonly context: number
}

export type Mode = { readonly id: string; readonly name: string; readonly description?: string }

export type Command = { readonly name: string; readonly description: string; readonly kind: "command" | "skill" }

export type Catalog = {
  readonly directory: string
  readonly models: ReadonlyArray<CatalogModel>
  readonly modes: ReadonlyArray<Mode>
  readonly defaultMode?: string
  readonly commands: ReadonlyArray<Command>
  readonly defaultModel?: ModelKey
}

export type ModelKey = { readonly providerID: string; readonly id: string }

export type Selection = {
  readonly model: ModelKey
  readonly variant?: string
  readonly mode?: string
}

export function configOptions(catalog: Catalog, selection: Selection): SessionConfigOption[] {
  const variants = findModel(catalog, selection.model)?.variants ?? []
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: `${selection.model.providerID}/${selection.model.id}`,
      options: modelOptions(catalog),
    },
    ...(variants.length > 0
      ? [
          {
            id: "effort",
            name: "Effort",
            description: "Available effort levels for this model",
            category: "thought_level" as const,
            type: "select" as const,
            currentValue:
              selection.variant === DefaultVariant
                ? DefaultVariant
                : (pickVariant(selection.variant, variants) ?? DefaultVariant),
            options: [...new Set([...variants, DefaultVariant])].map((variant) => ({
              value: variant,
              name: variantName(variant),
            })),
          },
        ]
      : []),
    ...(selection.mode && catalog.modes.length > 0
      ? [
          {
            id: "mode",
            name: "Session Mode",
            category: "mode" as const,
            type: "select" as const,
            currentValue: selection.mode,
            options: catalog.modes.map((mode) => ({
              value: mode.id,
              name: mode.name,
              ...(mode.description ? { description: mode.description } : {}),
            })),
          },
        ]
      : []),
  ]
}

/** Parses `provider/model` or `provider/model/variant`; provider IDs may themselves contain no slash. */
export function parseModel(value: string, catalog: Catalog): { model: ModelKey; variant?: string } | undefined {
  const exact = catalog.models.find((model) => `${model.providerID}/${model.id}` === value)
  if (exact) return { model: { providerID: exact.providerID, id: exact.id } }
  const separator = value.lastIndexOf("/")
  if (separator < 0) return undefined
  const base = catalog.models.find((model) => `${model.providerID}/${model.id}` === value.slice(0, separator))
  const variant = value.slice(separator + 1)
  if (!base || !base.variants.includes(variant)) return undefined
  return { model: { providerID: base.providerID, id: base.id }, variant }
}

export function findModel(catalog: Catalog, model: ModelKey | undefined) {
  if (!model) return undefined
  return catalog.models.find((item) => item.providerID === model.providerID && item.id === model.id)
}

/** The variant a freshly selected model starts with: `default` when it has one, else its first. */
export function initialVariant(catalog: Catalog, model: ModelKey) {
  const variants = findModel(catalog, model)?.variants ?? []
  return pickVariant(undefined, variants)
}

export function hasVariant(catalog: Catalog, model: ModelKey, variant: string) {
  return variant === DefaultVariant || (findModel(catalog, model)?.variants ?? []).includes(variant)
}

/** The model a session without an explicit one shows: the Location default, else the first listed. */
export function defaultModel(catalog: Catalog): ModelKey | undefined {
  if (catalog.defaultModel) return catalog.defaultModel
  const first = catalog.models[0]
  return first ? { providerID: first.providerID, id: first.id } : undefined
}

export function defaultMode(catalog: Catalog) {
  return catalog.defaultMode ?? catalog.modes[0]?.id
}

export function variantName(variant: string) {
  return variant
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function pickVariant(variant: string | undefined, variants: ReadonlyArray<string>) {
  if (variant && variants.includes(variant)) return variant
  if (variants.includes(DefaultVariant)) return DefaultVariant
  return variants[0]
}

function modelOptions(catalog: Catalog) {
  const providers = [...new Set(catalog.models.map((model) => model.providerID))]
  return providers.flatMap((providerID) =>
    catalog.models
      .filter((model) => model.providerID === providerID)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((model) => ({ value: `${model.providerID}/${model.id}`, name: `${model.providerName}/${model.name}` })),
  )
}
