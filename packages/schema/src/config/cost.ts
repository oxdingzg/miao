export * as ConfigCost from "./cost"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Cost")({
  budget_usd: Schema.Finite.pipe(Schema.optional),
}) {}
