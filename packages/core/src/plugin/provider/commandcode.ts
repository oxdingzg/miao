import { Effect, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { CommandCode } from "../../commandcode"
import { EventV2 } from "../../event"
import { Flag } from "../../flag/flag"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ModelsDev } from "../../models-dev"
import { ProviderV2 } from "../../provider"
import { define } from "../define"

const PROVIDER_ID = ProviderV2.ID.make("commandcode")
const INTEGRATION_ID = Integration.ID.make("commandcode")

// The plan tiers that gate models (cheapest first), matching the `plans` the
// catalog carries for Command Code. A configured plan outside this set (for
// example `provider` or `team`) is treated as unknown and hides nothing.
const PLAN_TIERS = new Set(["go", "goat", "pro", "max"])

// Command Code's plan is not readable headlessly (the vendor says to ask the
// user), so it comes from `MIAO_COMMANDCODE_PLAN`. An unknown plan, or a model
// with no plan info, stays visible: hiding a model the account can call is
// worse than showing one it cannot.
const available = (plan: string | undefined, plans: readonly string[] | undefined) =>
  plan === undefined ||
  plan === "" ||
  !PLAN_TIERS.has(plan) ||
  plans === undefined ||
  plans.length === 0 ||
  plans.includes(plan)

/**
 * The Provider API's model list carries no capabilities for the models Command
 * Code serves. Those models keep their canonical vendor ids though (for example
 * `deepseek/deepseek-v4.1-flash`), and the catalog lists the same ids under
 * their origin providers with `modalities.input`. Index the first declaration
 * per id so a model that accepts images is not forced to text-only; an id the
 * catalog does not carry stays on the conservative default.
 */
const catalogModalities = (catalog: Record<string, ModelsDev.Provider>) => {
  const inputs = new Map<string, ReadonlyArray<string>>()
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) {
      const input = model.modalities?.input
      if (input !== undefined && !inputs.has(model.id)) inputs.set(model.id, input)
    }
  }
  return inputs
}

/**
 * Command Code subscription support.
 *
 * The login is a browser-assisted API-key transfer (a loopback callback plus a
 * key/env fallback), and the model list is discovered from the Provider API's
 * `/provider/v1/models` once a key is connected, so new models appear without a
 * release. Models are routed through `CommandCode.route` by the session runner.
 */
export const CommandCodePlugin = define<HttpClient.HttpClient | EventV2.Service | ModelsDev.Service>({
  id: "commandcode",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2.Service
    const modelsDev = yield* ModelsDev.Service

    yield* ctx.integration.transform((draft) => {
      draft.update("commandcode", (integration) => {
        integration.name = "Command Code"
      })
      draft.method.update(CommandCode.oauth(http))
    })

    const load = Effect.fn("CommandCodePlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return [] as ReadonlyArray<CommandCode.CatalogModel>
      const credential = yield* ctx.integration.connection
        .resolve(connection)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!credential) return [] as ReadonlyArray<CommandCode.CatalogModel>
      const key = credential.type === "oauth" ? credential.access : credential.key
      return yield* CommandCode.fetchModels(http, key)
    })

    // A key connected while the process runs reaches an open catalog.
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === INTEGRATION_ID),
      Stream.runForEach(() => ctx.catalog.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.catalog.transform((catalog) =>
      Effect.gen(function* () {
        if (!catalog.provider.get(PROVIDER_ID)) return
        catalog.provider.update(PROVIDER_ID, (provider) => {
          provider.integrationID = INTEGRATION_ID
        })
        const models = yield* load()
        const catalogModels = yield* modelsDev.get()
        const entries = catalogModels["commandcode"]?.models
        const plan = Flag.MIAO_COMMANDCODE_PLAN?.trim().toLowerCase()
        const modalities = catalogModalities(catalogModels)
        for (const model of models) {
          catalog.model.update(PROVIDER_ID, ModelV2.ID.make(model.id), (draft) => {
            draft.name = model.name ?? model.id
            // The models endpoint reports neither capabilities nor pricing, so
            // borrow the input modalities the catalog lists for the same model
            // id; ids the catalog does not carry stay on the conservative
            // text-only default until it does.
            draft.capabilities = {
              tools: true,
              input: [...(modalities.get(model.id) ?? ["text"])],
              output: ["text"],
            }
            draft.limit = { context: model.contextLength ?? 128_000, output: 32_768 }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            // The catalog records the plan tiers that include each model; hide a
            // model the connected account's plan cannot call.
            draft.enabled = available(plan, entries?.[model.id]?.plans)
          })
        }
      }),
    )
  }),
})
