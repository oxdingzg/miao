export * as SessionModelRoute from "./session-model-route"

import { Schema } from "effect"
import { Model } from "./model"
import { Credential } from "./credential"
import { optional } from "./schema"

/** Engine-owned routes use a reserved product namespace; wire model names are display metadata. */
export const Info = Schema.Struct({
  model: Model.Ref,
  productModel: optional(Model.Ref),
  credentialID: optional(Credential.ID),
  protocol: Schema.String,
  wireModel: Schema.String,
  default: Schema.Boolean,
  variants: Schema.optional(Schema.Array(Model.VariantID)),
}).annotate({ identifier: "SessionModelRoute.Info" })
export type Info = typeof Info.Type

export const Binding = Schema.Struct({
  protocol: Schema.String,
  model: Schema.String,
  route_id: Schema.optional(Schema.NullOr(Schema.String)),
  variant: Schema.optional(Schema.NullOr(Model.VariantID)),
})
export type Binding = typeof Binding.Type

export function reference(routeID: string | null, variant?: string): Model.Ref {
  return Schema.decodeUnknownSync(Model.Ref)({
    providerID: routeID === null ? DefaultProviderID : ProviderID,
    id: routeID ?? DefaultModelID,
    ...(variant === undefined ? {} : { variant }),
  })
}

export const ProviderID = "native-engine"
export const DefaultProviderID = "native-engine-default"
export const DefaultModelID = "default"
