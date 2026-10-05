import { Effect, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { CommandCode } from "../../commandcode"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { define } from "../define"

const PROVIDER_ID = ProviderV2.ID.make("commandcode")
const INTEGRATION_ID = Integration.ID.make("commandcode")

/**
 * Command Code subscription support.
 *
 * The login is a browser-assisted API-key transfer (a loopback callback plus a
 * key/env fallback), and the model list is discovered from the Provider API's
 * `/provider/v1/models` once a key is connected, so new models appear without a
 * release. Models are routed through `CommandCode.route` by the session runner.
 */
export const CommandCodePlugin = define<HttpClient.HttpClient | EventV2.Service>({
  id: "commandcode",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2.Service

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
        for (const model of models) {
          catalog.model.update(PROVIDER_ID, ModelV2.ID.make(model.id), (draft) => {
            draft.name = model.name ?? model.id
            // The models endpoint reports neither capabilities nor pricing, so
            // these stay conservative until the catalog carries them.
            draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
            draft.limit = { context: model.contextLength ?? 128_000, output: 32_768 }
            draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
            draft.enabled = true
          })
        }
      }),
    )
  }),
})
