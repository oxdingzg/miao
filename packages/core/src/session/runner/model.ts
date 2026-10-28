// Keep historical model-resolution imports compatible while Session owns the service.
export {
  ModelNotSelectedError,
  ModelUnavailableError,
  VariantUnavailableError,
  UnsupportedApiError,
  Service,
  layerWith,
  fromCatalogModel,
  resolveWithInfo,
  resolve,
  supported,
  locationLayer,
  node,
} from "../model"
export type { Error, Resolved, Interface } from "../model"
export * as SessionRunnerModel from "../model"
