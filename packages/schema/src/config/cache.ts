export * as ConfigCache from "./cache"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Cache")({
  ttl_seconds: NonNegativeInt.pipe(Schema.optional),
}) {}
