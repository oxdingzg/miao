export * as FormatView from "./format-view"

import { Schema } from "effect"

// The V1 formatter status view model projected to clients.
export const Status = Schema.Struct({
  name: Schema.String,
  extensions: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "FormatterStatus" })
export type Status = Schema.Schema.Type<typeof Status>

export const FormatterStatus = Status
export type FormatterStatus = Status
