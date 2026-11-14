import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Config } from "@miao/core/config"
import { ConfigLSP } from "@miao/core/config/lsp"
import { FSUtil } from "@miao/core/fs-util"
import { LSP } from "@miao/core/lsp"
import { LSPClient } from "@miao/core/lsp/client"
import { Location } from "@miao/core/location"
import { AbsolutePath } from "@miao/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const fixture = path.resolve(import.meta.dir, "fixture/mock-lsp.ts")

const it = testEffect(Layer.empty)

describe("LSP", () => {
  it.live("collects diagnostics from a configured server after touching a file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "a.ts")
          yield* Effect.promise(() => Bun.write(file, "const x = 1\n"))

          const activeLocation = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({
                      lsp: { mock: new ConfigLSP.Server({ command: ["bun", fixture], extensions: [".ts"] }) },
                    }),
                  }),
                ]),
            }),
          )
          const built = AppNodeBuilder.build(LayerNode.group([LSP.node, FSUtil.node]), [
            [Location.node, activeLocation],
            [Config.node, config],
          ])

          yield* Effect.gen(function* () {
            const lsp = yield* LSP.Service
            yield* lsp.touchFile(file, "document")
            const diagnostics = yield* lsp.diagnostics()
            expect(diagnostics[LSPClient.fileURI(file)]?.[0]?.message).toBe("MOCK_ERROR")
          }).pipe(Effect.provide(built))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // A server that dies mid-handshake rejects its pending request. Because the LSP
  // node is advisory, that rejection must reach the caller as an ignorable error
  // and not as a defect, which would kill the tool that touched the file and
  // every tool settled alongside it in the same batch.
  it.live("touches a file without failing when the server exits before initialize", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "a.ts")
          yield* Effect.promise(() => Bun.write(file, "const x = 1\n"))

          const activeLocation = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({
                      lsp: {
                        mock: new ConfigLSP.Server({
                          command: ["bun", fixture, "--exit-before-initialize"],
                          extensions: [".ts"],
                        }),
                      },
                    }),
                  }),
                ]),
            }),
          )
          const built = AppNodeBuilder.build(LayerNode.group([LSP.node, FSUtil.node]), [
            [Location.node, activeLocation],
            [Config.node, config],
          ])

          yield* Effect.gen(function* () {
            const lsp = yield* LSP.Service
            yield* lsp.touchFile(file, "document")
            expect(yield* lsp.diagnostics()).toEqual({})
          }).pipe(Effect.provide(built))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
