export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Literals(["provider.use"])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  effect: Schema.Literals(["allow", "deny"]),
  resource: Schema.String,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  disable_paste_summary: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Disable the TUI paste summary",
  }),
}) {}
