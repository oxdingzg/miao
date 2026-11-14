export * as Catalog from "./catalog"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Option, Order, pipe, Schema } from "effect"
import { Catalog } from "@miao/schema/catalog"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { EventV2 } from "./event"
import { Policy } from "./policy"
import { State } from "./state"
import { Integration } from "./integration"

export type ProviderRecord = {
  provider: ProviderV2.MutableInfo
  models: Map<ModelV2.ID, ModelV2.MutableInfo>
}

export type DefaultModel = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export const PolicyActions = Schema.Literals(["provider.use"])

export const Event = Catalog.Event

type Data = {
  providers: Map<ProviderV2.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: ProviderV2.ID) => ProviderRecord | undefined
    update: (providerID: ProviderV2.ID, fn: (provider: ProviderV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID) => void
  }
  model: {
    get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => ModelV2.Info | undefined
    update: (providerID: ProviderV2.ID, modelID: ModelV2.ID, fn: (model: ModelV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (providerID: ProviderV2.ID) => Effect.Effect<ProviderV2.Info | undefined>
    readonly all: () => Effect.Effect<ProviderV2.Info[]>
    readonly available: () => Effect.Effect<ProviderV2.Info[]>
  }
  readonly model: {
    readonly get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<ModelV2.Info | undefined>
    readonly getAvailable: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<ModelV2.Info | undefined>
    readonly all: () => Effect.Effect<ModelV2.Info[]>
    readonly available: () => Effect.Effect<ModelV2.Info[]>
    readonly default: () => Effect.Effect<ModelV2.Info | undefined>
    readonly small: (providerID: ProviderV2.ID) => Effect.Effect<ModelV2.Info | undefined>
  }
}

// A key written into the provider's own config counts as a connection, wherever
// the V1 option lowering put it: the request body, the SDK settings (where
// openai-compatible keeps `apiKey`, and where model resolution reads it), or an
// auth header. Without this a provider that also names `env` variables, even an
// empty list, was reported unavailable although its key was configured.
function configuredCredential(provider: ProviderV2.Info) {
  if (typeof provider.request.body.apiKey === "string") return true
  if ("settings" in provider.api && typeof provider.api.settings?.apiKey === "string") return true
  return Object.keys(provider.request.headers).some((key) => /^(authorization|x-api-key|api-key)$/i.test(key))
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/Catalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const policy = yield* Policy.Service
    const integrations = yield* Integration.Service

    const available = (provider: ProviderV2.Info, integration: Integration.Info | undefined) => {
      if (provider.disabled) return false
      if (configuredCredential(provider)) return true
      if (integration?.connections.length) return true
      if (
        integration?.methods.length &&
        integration.methods.every((method) => method.type === "key" && method.optional)
      )
        return true
      return provider.integrationID === undefined && !integration
    }

    const projectModel = (model: ModelV2.Info, provider: ProviderV2.Info) => {
      const api =
        model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
          ? { ...provider.api, id: model.api.id }
          : model.api.type === "aisdk" && provider.api.type === "aisdk" && !model.api.url
            ? { ...model.api, url: provider.api.url, settings: { ...provider.api.settings, ...model.api.settings } }
            : model.api.type === "aisdk" && provider.api.type === "aisdk"
              ? { ...model.api, settings: { ...provider.api.settings, ...model.api.settings } }
              : model.api
      const request = {
        headers: { ...provider.request.headers, ...model.request.headers },
        body: { ...provider.request.body, ...model.request.body },
        variant: model.request.variant,
      }
      return ModelV2.Info.make({
        ...model,
        api,
        request,
      })
    }

    const normalizeApi = (item: ProviderV2.MutableInfo | ModelV2.MutableInfo) => {
      if (typeof item.request.body.baseURL !== "string") return
      item.api.url = item.request.body.baseURL
      delete item.request.body.baseURL
    }

    const state = State.create<Data, Draft>({
      initial: () => ({ providers: new Map() }),
      draft: (draft) => {
        const result: Draft = {
          provider: {
            list: () => Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = {
                  provider: ProviderV2.Info.empty(providerID) as ProviderV2.MutableInfo,
                  models: new Map<ModelV2.ID, ModelV2.MutableInfo>(),
                }
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
              normalizeApi(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) => draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = {
                  provider: ProviderV2.Info.empty(providerID) as ProviderV2.MutableInfo,
                  models: new Map<ModelV2.ID, ModelV2.MutableInfo>(),
                }
                draft.providers.set(providerID, record)
              }
              const model =
                record.models.get(modelID) ?? (ModelV2.Info.empty(providerID, modelID) as ModelV2.MutableInfo)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
              normalizeApi(model)
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("CatalogV2.finalize")(function* (catalog) {
        if (policy.hasStatements()) {
          for (const record of [...catalog.provider.list()]) {
            if ((yield* policy.evaluate("provider.use", record.provider.id, "allow")) === "deny") {
              catalog.provider.remove(record.provider.id)
            }
          }
        }
        yield* events.publish(Event.Updated, {})
      }),
    })
    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("CatalogV2.provider.get")(function* (providerID) {
          return state.get().providers.get(providerID)?.provider
        }),

        all: Effect.fn("CatalogV2.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map((record) => record.provider)
        }),

        available: Effect.fn("CatalogV2.provider.available")(function* () {
          const active = new Map((yield* integrations.list()).map((integration) => [integration.id, integration]))
          return (yield* result.provider.all()).filter((provider) =>
            available(provider, active.get(provider.integrationID ?? Integration.ID.make(provider.id))),
          )
        }),
      },

      model: {
        get: Effect.fn("CatalogV2.model.get")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const model = record.models.get(modelID)
          return model && projectModel(model, record.provider)
        }),

        getAvailable: Effect.fn("CatalogV2.model.getAvailable")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          const model = record?.models.get(modelID)
          if (!record || !model?.enabled || record.provider.disabled) return
          // An explicit Session selection needs one model, not a projection and
          // sort of the entire catalog. Keep auth live rather than caching it.
          if (!configuredCredential(record.provider)) {
            const integration = yield* integrations.get(
              record.provider.integrationID ?? Integration.ID.make(providerID),
            )
            if (!available(record.provider, integration)) return
          }
          return projectModel(model, record.provider)
        }),

        all: Effect.fn("CatalogV2.model.all")(function* () {
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => {
              return Array.fromIterable(record.models.values()).map((model) => projectModel(model, record.provider))
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("CatalogV2.model.available")(function* () {
          const providers = new Set((yield* result.provider.available()).map((provider) => provider.id))
          return (yield* result.model.all()).filter((model) => providers.has(model.providerID) && model.enabled)
        }),

        default: Effect.fn("CatalogV2.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (provider && (yield* result.provider.available()).some((item) => item.id === provider.id)) {
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID)
              if (model?.enabled) return model
            }
          }

          return Option.getOrUndefined(
            pipe(
              yield* result.model.available(),
              Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
              Array.head,
            ),
          )
        }),

        small: Effect.fn("CatalogV2.model.small")(function* (providerID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const provider = record.provider

          // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
          if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
            return
          }

          if (providerID === ProviderV2.ID.opencode) {
            const gpt5Nano = record.models.get(ModelV2.ID.make("gpt-5-nano"))
            if (gpt5Nano?.enabled && gpt5Nano.status === "active") return projectModel(gpt5Nano, provider)
          }

          const candidates = pipe(
            Array.fromIterable(record.models.values()),
            Array.filter(
              (model) =>
                model.providerID === providerID &&
                model.enabled &&
                model.status === "active" &&
                model.capabilities.input.some((item) => item.startsWith("text")) &&
                model.capabilities.output.some((item) => item.startsWith("text")) &&
                // Auxiliary calls produce text; image input does not imply image generation.
                model.capabilities.output.every((item) => item.startsWith("text")),
            ),
            Array.map((model) => ({
              model,
              // What an auxiliary request costs: the base input rate for the prompt
              // and the cache-read rate for the prefix a compaction reuses. A model
              // the catalog prices at zero is free on a plan rather than unknown, so
              // only an absent price stays `undefined`.
              price: model.cost[0] ? model.cost[0].input + model.cost[0].cache.read : undefined,
              age: (Date.now() - model.time.released) / (1000 * 60 * 60 * 24 * 30),
              small: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
            })),
            Array.filter((item) => item.age <= 18),
          )

          // Price decides whenever the catalog reports one, because a name does not
          // price a model: a `-fast` or `-flash` variant can cost more than the
          // model it derives from. Newest breaks a tie between equally priced
          // models, the one place recency is worth preferring.
          const priced = Array.filter(candidates, (item) => item.price !== undefined)
          const chosen = Option.getOrUndefined(
            priced.length > 0
              ? pipe(
                  priced,
                  Array.sortWith((item) => item.age, Order.Number),
                  Array.sortWith((item) => item.price ?? Number.POSITIVE_INFINITY, Order.Number),
                  Array.head,
                )
              : pipe(
                  // No price anywhere: a subscription plan prices every model at
                  // zero, so the family name is the only signal left for "small".
                  Array.filter(candidates, (item) => item.small),
                  Array.sortWith((item) => item.age, Order.Number),
                  Array.head,
                ),
          )
          return chosen ? projectModel(chosen.model, provider) : undefined
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const locationLayer = layer.pipe(
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Policy.locationLayer),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Policy.node, Integration.node] })
