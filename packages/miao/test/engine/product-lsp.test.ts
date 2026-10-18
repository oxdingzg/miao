import { expect } from "bun:test"
import { stat } from "node:fs/promises"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { Effect, Layer, Schema } from "effect"
import { ProductLsp } from "../../src/engine/product-lsp"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.empty)
const disabled = {
  typescript: { disabled: true },
  gopls: { disabled: true },
  rust: { disabled: true },
  pyright: { disabled: true },
  clangd: { disabled: true },
}

it.live("product LSP configuration preserves overrides, initialization, privacy and scoped cleanup", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const config = Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ lsp: false }) }),
          new Config.Document({
            type: "document",
            info: Schema.decodeUnknownSync(Config.Info)({
              lsp: {
                ...disabled,
                fixture: {
                  command: [process.execPath, "--version"],
                  extensions: [".fixture"],
                  env: { FIXTURE: "configured" },
                  initialization: { marker: true },
                },
                missing: { command: ["miao-language-server-that-does-not-exist"], extensions: [".missing"] },
              },
            }),
          }),
        ]),
    })
    const file = yield* Effect.scoped(
      Effect.gen(function* () {
        const options = yield* ProductLsp.prepare(location, { binary: "fixture", model: "fixture" })
        expect(options.lspConfigFile).toBeDefined()
        const file = options.lspConfigFile
        if (!file) throw new Error("missing product LSP manifest")
        expect(yield* Effect.promise(() => Bun.file(file).json())).toEqual([
          {
            name: "fixture",
            argv: [process.execPath, "--version"],
            extensions: [".fixture"],
            env: { FIXTURE: "configured" },
            initialization: { marker: true },
          },
        ])
        if (process.platform !== "win32") expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
        return file
      }).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(Location.Service, {
          ...location,
          project: { id: Project.ID.global, directory: location.directory },
        }),
      ),
    )
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

it.live("explicit native LSP manifest wins without requiring product services", () =>
  Effect.gen(function* () {
    const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    expect(
      yield* ProductLsp.prepare(location, { binary: "fixture", model: "fixture", lspConfigFile: "/operator/lsp.json" }),
    ).toEqual({})
  }),
)

it.live("disabled product LSP does not generate a manifest", () =>
  Effect.gen(function* () {
    const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    expect(
      yield* ProductLsp.prepare(location, { binary: "fixture", model: "fixture" }).pipe(
        Effect.provideService(Config.Service, {
          entries: () =>
            Effect.succeed([new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ lsp: false }) })]),
        }),
        Effect.provideService(Location.Service, {
          ...location,
          project: { id: Project.ID.global, directory: location.directory },
        }),
      ),
    ).toEqual({})
  }),
)

it.live("overlapping product language servers fail explicitly instead of picking an arbitrary one", () =>
  Effect.gen(function* () {
    const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    const error = yield* ProductLsp.prepare(location, { binary: "fixture", model: "fixture" }).pipe(
      Effect.provideService(Config.Service, {
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: Schema.decodeUnknownSync(Config.Info)({
                lsp: {
                  ...disabled,
                  first: { command: [process.execPath], extensions: [".fixture"] },
                  second: { command: [process.execPath], extensions: ["fixture"] },
                },
              }),
            }),
          ]),
      }),
      Effect.provideService(Location.Service, {
        ...location,
        project: { id: Project.ID.global, directory: location.directory },
      }),
      Effect.flip,
    )
    expect(error.code).toBe("engine_lsp_overlap")
  }),
)
