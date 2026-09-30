import { Effect, Scope, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"
import { TencentTokenPlan } from "../../tencent-token-plan"
import { define } from "../internal"

/**
 * Hides the catalog models a Token Plan key cannot call.
 *
 * models.dev describes the plan from the outside, so it lists models the key is
 * not scoped for, and calling one answers 403002 "not authorized". Only the
 * gateway's own per-key model list separates the two. Plugin boot is part of the
 * catalog materialize that waits on it, so the lookup is forked rather than
 * awaited, and it reloads the catalog once its answer arrives.
 */
export const TencentTokenPlanPlugin = define<HttpClient.HttpClient | EventV2.Service | Scope.Scope>({
  id: "tencent-token-plan",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    // Model IDs each gateway provider's key may call, from the last lookup.
    let authorized = new Map<ProviderV2.ID, ReadonlySet<string>>()
    // Gateway providers the last materialize saw, with the credential keying them.
    let gateway = new Map<ProviderV2.ID, Integration.ID>()

    const signature = (sets: Map<ProviderV2.ID, ReadonlySet<string>>) =>
      [...sets]
        .map(([providerID, models]) => `${providerID}:${[...models].sort().join(",")}`)
        .sort()
        .join("|")

    const lookup = Effect.fn("TencentTokenPlanPlugin.lookup")(function* () {
      const next = new Map<ProviderV2.ID, ReadonlySet<string>>()
      for (const [providerID, integrationID] of gateway) {
        const connection = yield* ctx.integration.connection.active(integrationID)
        const credential =
          connection === undefined
            ? undefined
            : yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (credential === undefined) continue
        const models = yield* TencentTokenPlan.authorizedModels({
          baseURL: TencentTokenPlan.API,
          key: credential.type === "oauth" ? credential.access : credential.key,
          http,
        })
        if (models === undefined) continue
        next.set(providerID, models)
      }
      // Every catalog rebuild triggers this lookup, so an answer that changes
      // nothing must not reload the catalog and trigger it again.
      if (signature(next) === signature(authorized)) return
      authorized = next
      yield* ctx.catalog.reload()
    })

    // A key connected while the process runs reaches an open catalog.
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.runForEach(() => lookup()),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.catalog.transform((catalog) => {
      const seen = new Map<ProviderV2.ID, Integration.ID>()
      for (const record of catalog.provider.list()) {
        if (record.provider.api.type !== "aisdk") continue
        if (record.provider.api.url !== TencentTokenPlan.API) continue
        const providerID = ProviderV2.ID.make(record.provider.id)
        seen.set(providerID, Integration.ID.make(record.provider.integrationID ?? providerID))
        const models = authorized.get(providerID)
        if (models === undefined) continue
        // Keep a model when either its catalog ID or the ID it sends is
        // authorized: a config alias names the gateway model behind it.
        for (const [modelID, model] of record.models) {
          if (models.has(modelID) || models.has(model.api.id)) continue
          catalog.model.remove(record.provider.id, modelID)
        }
      }
      gateway = seen
      // A transform cannot wait for the gateway without holding up the catalog
      // it is building, so the lookup runs beside it and reloads once it knows
      // the answer. Its answer is cached per key, so a rebuild that changes
      // nothing costs neither a request nor a reload.
      return lookup().pipe(Effect.forkIn(scope), Effect.asVoid)
    })
  }),
})
