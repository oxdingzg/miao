import { expect } from "bun:test"
import { Catalog } from "@miao/core/catalog"
import { Credential } from "@miao/core/credential"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Integration } from "@miao/core/integration"
import { Location } from "@miao/core/location"
import { ModelV2 } from "@miao/core/model"
import { Project } from "@miao/core/project"
import { ProviderV2 } from "@miao/core/provider"
import { AbsolutePath } from "@miao/core/schema"
import { Effect, Layer } from "effect"
import { ProductRoutes } from "../../src/engine/product-routes"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const location = Location.Ref.make({ directory: AbsolutePath.make("/route-parity-workspace") })
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node, Integration.node, Location.node]), [
  [
    Location.node,
    Layer.succeed(Location.Service, { ...location, project: { id: Project.ID.global, directory: location.directory } }),
  ],
])
const SHARED = "/route-parity/credentials.db"
const SAFEGUARD = "openai.gpt-oss-safeguard-20b"
const RESPONSES = "openai.gpt-oss-120b"

type Route = { id: string; provider: string; endpoint: string; credential: { type: string; key?: string } }

/**
 * Bedrock Mantle in the product catalog: the plugin leaves the package name on
 * every model and the region on the provider settings.
 */
const catalog = (region?: string) =>
  Effect.gen(function* () {
    const services = yield* Catalog.Service
    yield* services.transform((draft) => {
      draft.provider.update(ProviderV2.ID.amazonBedrock, (provider) => {
        // Bedrock resolves its own AWS chain, so the provider stays available
        // without a product integration connection.
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/amazon-bedrock/mantle",
          ...(region === undefined ? {} : { settings: { region } }),
        }
      })
      for (const id of [SAFEGUARD, RESPONSES]) {
        draft.model.update(ProviderV2.ID.amazonBedrock, ModelV2.ID.make(id), (model) => {
          model.api.id = ModelV2.ID.make(id)
          model.capabilities.tools = true
          model.capabilities.output = ["text"]
        })
      }
      draft.model.default.set(ProviderV2.ID.amazonBedrock, ModelV2.ID.make(RESPONSES))
    })
  })

/**
 * The manifest `profile()` produced, with a Bedrock API key in the environment
 * so the account has a bearer token to send.
 */
const manifest = (input: { model?: string; region?: string; env?: Record<string, string> }) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = { key: process.env.AWS_BEARER_TOKEN_BEDROCK, region: process.env.AWS_REGION }
      process.env.AWS_BEARER_TOKEN_BEDROCK = "BEDROCK_SECRET"
      if (input.env?.AWS_REGION === undefined) delete process.env.AWS_REGION
      else process.env.AWS_REGION = input.env.AWS_REGION
      return previous
    }),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* catalog(input.region)
          const options = yield* ProductRoutes.prepare(location, { binary: "fixture", model: input.model ?? "" })
          const file = options.modelRoutesConfigFile
          if (!file) throw new Error("missing product routes manifest")
          return (yield* Effect.promise(() => Bun.file(file).json())) as Route[]
        }),
      ).pipe(Effect.provide(layer), Effect.provideService(Credential.SharedDatabasePath, SHARED)),
    (previous) =>
      Effect.sync(() => {
        if (previous.key === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK
        else process.env.AWS_BEARER_TOKEN_BEDROCK = previous.key
        if (previous.region === undefined) delete process.env.AWS_REGION
        else process.env.AWS_REGION = previous.region
      }),
  )

it.live("mantle keeps the Responses wire for every model the plugin does not force onto chat", () =>
  Effect.gen(function* () {
    const routes = yield* manifest({ region: "eu-west-1" })
    expect(routes.find((route) => route.id === `amazon-bedrock/${RESPONSES}`)).toMatchObject({
      provider: "openai-responses",
      endpoint: "https://bedrock-mantle.eu-west-1.api.aws/v1/responses",
      credential: { type: "environment", key: "AWS_BEARER_TOKEN_BEDROCK" },
    })
  }),
)

it.live("mantle safeguard models stay on the chat wire", () =>
  Effect.gen(function* () {
    const routes = yield* manifest({ model: `amazon-bedrock/${SAFEGUARD}`, region: "eu-west-1" })
    expect(routes.find((route) => route.id === `amazon-bedrock/${SAFEGUARD}`)).toMatchObject({
      provider: "openai-chat",
      endpoint: "https://bedrock-mantle.eu-west-1.api.aws/v1/chat/completions",
    })
  }),
)

it.live("mantle follows the region the AI SDK would resolve", () =>
  Effect.gen(function* () {
    const routes = yield* manifest({ env: { AWS_REGION: "ap-southeast-2" } })
    expect(routes.find((route) => route.id === `amazon-bedrock/${RESPONSES}`)?.endpoint).toBe(
      "https://bedrock-mantle.ap-southeast-2.api.aws/v1/responses",
    )
  }),
)

const AZURE_MODEL = "gpt-4.1"
const AZURE_DEPLOYMENT = "prod-chat"

/**
 * Azure OpenAI in the product catalog: the plugin keeps the deployment on the
 * model, the resource on the provider, and picks the Chat wire through
 * `useCompletionUrls`; without it the same model would ask for Responses.
 */
const azureCatalog = (options: { deployment?: boolean }) =>
  Effect.gen(function* () {
    const services = yield* Catalog.Service
    const integrations = yield* Integration.Service
    yield* integrations.transform((draft) => {
      draft.method.update({
        integrationID: Integration.ID.make("azure"),
        method: { type: "env", names: ["AZURE_API_KEY"] },
      })
    })
    yield* services.transform((draft) => {
      draft.provider.update(ProviderV2.ID.azure, (provider) => {
        provider.integrationID = Integration.ID.make("azure")
        provider.api = { type: "aisdk", package: "@ai-sdk/azure", settings: { resourceName: "contoso" } }
        provider.request.body.useCompletionUrls = true
        if (options.deployment === true) provider.request.body.useDeploymentBasedUrls = true
      })
      draft.model.update(ProviderV2.ID.azure, ModelV2.ID.make(AZURE_MODEL), (model) => {
        model.api.id = ModelV2.ID.make(AZURE_DEPLOYMENT)
        model.capabilities.tools = true
        model.capabilities.output = ["text"]
      })
      draft.model.default.set(ProviderV2.ID.azure, ModelV2.ID.make(AZURE_MODEL))
    })
  })

/** The manifest `profile()` produced, with an Azure key in the environment. */
const azureManifest = (options: { deployment?: boolean; version?: string } = {}) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.AZURE_API_KEY
      process.env.AZURE_API_KEY = "AZURE_SECRET"
      return previous
    }),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* azureCatalog(options)
          const prepared = yield* ProductRoutes.prepare(location, { binary: "fixture", model: "" })
          const file = prepared.modelRoutesConfigFile
          if (!file) throw new Error("missing product routes manifest")
          return (yield* Effect.promise(() => Bun.file(file).json())) as Array<Route & { auth?: unknown }>
        }),
      ).pipe(Effect.provide(layer), Effect.provideService(Credential.SharedDatabasePath, SHARED)),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.AZURE_API_KEY
        else process.env.AZURE_API_KEY = previous
      }),
  )

it.live("azure chat keeps the plugin's resource URL and the v1 api-version default", () =>
  Effect.gen(function* () {
    const routes = yield* azureManifest()
    expect(routes.find((route) => route.id === `azure/${AZURE_MODEL}`)).toMatchObject({
      provider: "azure",
      endpoint: "https://contoso.openai.azure.com/openai/v1/chat/completions",
      auth: { query: { "api-version": "v1" } },
      credential: { type: "environment", key: "AZURE_API_KEY" },
    })
  }),
)

it.live("azure deployments carry the deployment in the path, not the version segment", () =>
  Effect.gen(function* () {
    const routes = yield* azureManifest({ deployment: true })
    expect(routes.find((route) => route.id === `azure/${AZURE_MODEL}`)?.endpoint).toBe(
      `https://contoso.openai.azure.com/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions`,
    )
  }),
)
