export * as Model from "./model"
import type { Provider } from "@miao/schema/view-models"

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
