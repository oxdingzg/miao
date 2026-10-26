export * as Model from "./model"
import type { Provider } from "@miao/schema/view-models"

export type Selection = { id: string; providerID: string; variant?: string }

/**
 * The model a Session created by `/clear` starts on. A native Session's model
 * is an operator-bound route and the footer has no local selection there, so
 * carrying nothing let the operator's default route take over and silently
 * switched models.
 */
export function newSessionModel(input: {
  session?: { execution?: { selection?: string }; model?: Selection }
  selected?: { providerID: string; modelID: string }
  variant?: string
}): Selection | undefined {
  if (input.session?.execution?.selection === "operator" && input.session.model) return input.session.model
  if (!input.selected) return undefined
  return {
    id: input.selected.modelID,
    providerID: input.selected.providerID,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
  }
}

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string | undefined, modelID: string | undefined) {
  if (providerID === undefined || modelID === undefined) return
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
) {
  if (providerID === undefined || modelID === undefined) return "Unknown model"
  return get(list, providerID, modelID)?.name ?? modelID
}
