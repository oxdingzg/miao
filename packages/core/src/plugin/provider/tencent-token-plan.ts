import { Effect, Stream } from "effect"
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
 * gateway's own per-key model list separates the two, and the listing a request
 * reads is the materialize the plugin boot builds, so the lookup is part of that
 * materialize rather than a reload after it. Its answer is cached per key, which
 * keeps a later rebuild from asking the gateway again.
 */
export const TencentTokenPlanPlugin = define<HttpClient.HttpClient | EventV2.Service>({
  id: "tencent-token-plan",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2.Service
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
      return next
    })

    // A key connected while the process runs reaches an open catalog.
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* lookup()
          // Every catalog rebuild triggers a lookup, so an answer that changes
          // nothing must not reload the catalog and trigger it again.
          if (signature(next) === signature(authorized)) return
          authorized = next
          yield* ctx.catalog.reload()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.catalog.transform((catalog) =>
      Effect.gen(function* () {
        const gateways = catalog.provider.list().flatMap((record) => {
          if (record.provider.api.type !== "aisdk") return []
          if (record.provider.api.url !== TencentTokenPlan.API) return []
          return [{ record, providerID: ProviderV2.ID.make(record.provider.id) }]
        })
        gateway = new Map(
          gateways.map(({ record, providerID }) => {
            return [providerID, Integration.ID.make(record.provider.integrationID ?? providerID)] as const
          }),
        )
        // The lookup is awaited here, and not beside the materialize, so the
        // catalog a request reads is already filtered. Its answer is cached per
        // key, so the wait is only as long as the gateway is slow to answer.
        authorized = yield* lookup()
        for (const { record, providerID } of gateways) {
          const models = authorized.get(providerID)
          if (models === undefined) continue
          // Keep a model when either its catalog ID or the ID it sends is
          // authorized: a config alias names the gateway model behind it.
          for (const [modelID, model] of record.models) {
            if (models.has(modelID) || models.has(model.api.id)) continue
            catalog.model.remove(record.provider.id, modelID)
          }
        }
      }),
    )
  }),
})
