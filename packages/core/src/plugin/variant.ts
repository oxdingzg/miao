export * as VariantPlugin from "./variant"

import { ModelVariants } from "../model-variants"
import { Effect } from "effect"
import { define } from "./internal"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            const generated = ModelVariants.generate({
              ...draft,
              api:
                draft.api.type === "native" && !draft.api.url && Object.keys(draft.api.settings).length === 0
                  ? { ...record.provider.api, id: draft.api.id }
                  : draft.api,
            })
            if (generated.length === 0) return

            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

export const generate = ModelVariants.generate
