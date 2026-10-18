import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { stat } from "node:fs/promises"
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
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.empty)
const location = Location.Ref.make({ directory: AbsolutePath.make("/native-routes-workspace") })
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node, Integration.node, Location.node]), [
  [
    Location.node,
    Layer.succeed(Location.Service, { ...location, project: { id: Project.ID.global, directory: location.directory } }),
  ],
])

it.live("product routes bind active accounts without persisting secrets and keep catalogs larger than 64 models", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const shared = `${tmp.path}/credentials.db`
    const db = new Database(shared)
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, time_created INTEGER)",
    )
    db.query("INSERT INTO credential VALUES (?,?,?,?,?)").run(
      "cred_command",
      "commandcode",
      "first",
      JSON.stringify({ type: "key", key: "COMMAND_SECRET" }),
      2,
    )
    db.query("INSERT INTO credential VALUES (?,?,?,?,?)").run(
      "cred_backup",
      "commandcode",
      "backup",
      JSON.stringify({ type: "key", key: "BACKUP_SECRET" }),
      0,
    )
    db.query("INSERT INTO credential VALUES (?,?,?,?,?)").run(
      "cred_subscription",
      "openai",
      "subscription",
      JSON.stringify({
        type: "oauth",
        methodID: "fixture",
        access: "OAUTH_SECRET",
        refresh: "REFRESH_SECRET",
        expires: Date.now() + 3_600_000,
      }),
      0,
    )
    db.query("INSERT INTO credential VALUES (?,?,?,?,?)").run(
      "cred_expired",
      "expired",
      "expired",
      JSON.stringify({
        type: "oauth",
        methodID: "fixture",
        access: "EXPIRED_SECRET",
        refresh: "REFRESH_SECRET",
        expires: 0,
      }),
      0,
    )
    db.close()
    const file = yield* Effect.scoped(
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        yield* integrations.transform((draft) => {
          draft.update(Integration.ID.make("commandcode"), () => {})
          draft.update(Integration.ID.make("openai"), () => {})
          draft.update(Integration.ID.make("expired"), () => {})
        })
        yield* catalog.transform((draft) => {
          for (const id of ["commandcode", "openai"]) {
            draft.provider.update(ProviderV2.ID.make(id), (provider) => {
              provider.integrationID = id === "commandcode" ? Integration.ID.make(id) : undefined
              provider.api = {
                type: "aisdk",
                package: id === "openai" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
              }
            })
          }
          for (let i = 0; i < 100; i++) {
            draft.model.update(ProviderV2.ID.make("commandcode"), ModelV2.ID.make(`model-${i}`), (model) => {
              model.api.id = ModelV2.ID.make(`remote-${i}`)
              model.capabilities.tools = true
              model.capabilities.input = ["text", "image", "pdf"]
              model.capabilities.output = ["text"]
              model.request.headers = { Authorization: "HEADER_SECRET", "User-Agent": "fixture" }
              model.request.body = { temperature: 0.1 }
              model.request.variant = "high"
              model.variants = [
                {
                  id: ModelV2.VariantID.make("high"),
                  headers: { "x-variant": "high" },
                  body: { reasoning_effort: "high" },
                },
              ]
            })
          }
          draft.model.update(ProviderV2.ID.make("openai"), ModelV2.ID.make("subscription-model"), (model) => {
            model.api.id = ModelV2.ID.make("remote-subscription")
            model.capabilities.tools = true
            model.capabilities.output = ["text"]
          })
          draft.model.default.set(ProviderV2.ID.make("commandcode"), ModelV2.ID.make("model-0"))
          for (const id of ["expired", "unsupported", "custom", "opencode-go"]) {
            draft.provider.update(ProviderV2.ID.make(id), (provider) => {
              provider.integrationID = Integration.ID.make(id === "expired" ? "expired" : "commandcode")
              provider.api = {
                type: "aisdk",
                package:
                  id === "unsupported"
                    ? "@ai-sdk/unknown"
                    : id === "opencode-go"
                      ? "@ai-sdk/anthropic"
                      : "@ai-sdk/openai-compatible",
                url: "https://example.invalid/v1/chat/completions?version=v1",
              }
            })
            draft.model.update(ProviderV2.ID.make(id), ModelV2.ID.make("model"), (model) => {
              model.capabilities.tools = true
              model.capabilities.output = ["text"]
            })
          }
        })
        const options = yield* ProductRoutes.prepare(location, { binary: "fixture", model: "" })
        expect(options).toMatchObject({
          model: "remote-0",
          provider: "openai-chat",
          credentialDatabase: shared,
          credentialID: "cred_command",
          credentialIntegration: "commandcode",
        })
        const file = options.modelRoutesConfigFile
        if (!file) throw new Error("missing product routes manifest")
        const content = yield* Effect.promise(() => Bun.file(file).text())
        for (const secret of [
          "COMMAND_SECRET",
          "BACKUP_SECRET",
          "OAUTH_SECRET",
          "REFRESH_SECRET",
          "HEADER_SECRET",
          "EXPIRED_SECRET",
        ])
          expect(content).not.toContain(secret)
        const routes = yield* Effect.promise(() => Bun.file(file).json())
        expect(routes).toHaveLength(205)
        const alternate = routes.find(
          (route: { account?: { id?: string; model_key: string } }) =>
            route.account?.id === "cred_backup" && route.account.model_key === "commandcode/model-0",
        )
        expect(alternate).toMatchObject({
          account: { id: "cred_backup", model_key: "commandcode/model-0", default: false },
          credential: { id: "cred_backup" },
        })
        expect(alternate.id).toMatch(/^account\/[a-f0-9]{64}$/)
        expect(yield* integrations.connection.active(Integration.ID.make("commandcode"))).toMatchObject({
          type: "credential",
          id: Credential.ID.make("cred_command"),
        })
        expect(routes.find((route: { id: string }) => route.id === "commandcode/model-0")).toMatchObject({
          primary: true,
          input_modalities: ["text", "image", "pdf"],
          default_variant: "high",
          request: { body: { temperature: 0.1 } },
          variants: [{ id: "high", body: { reasoning_effort: "high" }, headers: { "x-variant": "high" } }],
        })
        expect(routes.find((route: { id: string }) => route.id === "opencode-go/model").auth.headers).toEqual({
          "x-opencode-session": "$session",
        })
        expect(routes.find((route: { id: string }) => route.id === "custom/model").endpoint).toBe(
          "https://example.invalid/v1/chat/completions?version=v1",
        )
        for (const model of ["expired/model", "unsupported/model"]) {
          const error = yield* ProductRoutes.prepare(location, { binary: "fixture", model }).pipe(Effect.flip)
          expect(error.code).toBe("engine_routes_unsupported")
        }
        expect(routes.find((route: { id: string }) => route.id === "openai/subscription-model")).toMatchObject({
          provider: "subscription-responses",
          credential: { type: "database", path: shared, id: "cred_subscription", integration: "openai" },
        })
        expect(routes.find((route: { id: string }) => route.id === "commandcode/model-0").auth.headers).toEqual({
          "User-Agent": "fixture",
        })
        if (process.platform !== "win32") expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
        return file
      }).pipe(Effect.provide(layer), Effect.provideService(Credential.SharedDatabasePath, shared)),
    )
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

it.live("explicit operator routes retain precedence without consulting product services", () =>
  Effect.gen(function* () {
    expect(
      yield* ProductRoutes.prepare(location, {
        binary: "fixture",
        model: "operator",
        modelRoutesConfigFile: "/operator/routes.json",
      }),
    ).toEqual({})
    expect(
      yield* ProductRoutes.prepare(location, {
        binary: "fixture",
        model: "operator",
        provider: "openai-chat",
        credentialDatabase: "/operator/credentials.db",
      }),
    ).toEqual({})
  }).pipe(
    Effect.provideService(Location.Service, {
      ...location,
      project: { id: Project.ID.global, directory: location.directory },
    }),
  ),
)

it.live("automatic routes fail explicitly when the Location context omits the global credential broker", () =>
  Effect.gen(function* () {
    const error = yield* ProductRoutes.prepare(location, { binary: "fixture", model: "" }).pipe(Effect.flip)
    expect(error.code).toBe("engine_routes_credentials")
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, Location.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, {
            ...location,
            project: { id: Project.ID.global, directory: location.directory },
          }),
        ],
      ]),
    ),
  ),
)
