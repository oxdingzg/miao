import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@miao/core/config"
import { ConfigDiagnostics } from "@miao/core/config/diagnostics"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { Global } from "@miao/core/global"
import { Location } from "@miao/core/location"
import { Policy } from "@miao/core/policy"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function testLayer(directory: string, globalDirectory: string, projectDirectory = directory) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        {
          projectDirectory: AbsolutePath.make(projectDirectory),
          vcs: { type: "git", store: AbsolutePath.make(path.join(projectDirectory, ".git")) },
        },
      ),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}

describe("ConfigDiagnostics", () => {
  it.effect("reads unknown, missing and invalid keys out of a strict decode message", () =>
    Effect.sync(() => {
      const message = [
        `Unexpected key with value 1`,
        `  at ["modell"]`,
        `Unexpected key with value {"bogus":true}`,
        `  at ["providers"]["demo"]["options"]`,
        `Unexpected key with value "p"`,
        `  at ["plugins"][0]["name"]`,
        `Missing key`,
        `  at ["plugins"][0]["package"]`,
        `Expected string | undefined, got 123`,
        `  at ["model"]`,
      ].join("\n")

      expect(ConfigDiagnostics.parse(message)).toEqual([
        { kind: "unknown-key", path: ["modell"], value: 1, message: `Unexpected key with value 1` },
        {
          kind: "unknown-key",
          path: ["providers", "demo", "options"],
          value: { bogus: true },
          message: `Unexpected key with value {"bogus":true}`,
        },
        { kind: "unknown-key", path: ["plugins", "0", "name"], value: "p", message: `Unexpected key with value "p"` },
        { kind: "missing-key", path: ["plugins", "0", "package"], message: "Missing key" },
        { kind: "invalid-value", path: ["model"], message: "Expected string | undefined, got 123" },
      ])
    }),
  )

  it.effect("reports a document's unknown keys and stays empty for one it accepts", () =>
    Effect.sync(() => {
      expect(ConfigDiagnostics.of({ model: "openrouter/model", modell: "typo" })).toEqual([
        expect.objectContaining({ kind: "unknown-key", path: ["modell"], value: "typo" }),
      ])
      expect(ConfigDiagnostics.of({ model: "openrouter/model", providers: {} })).toEqual([])
    }),
  )

  it.effect("suggests only keys close enough to be a typo", () =>
    Effect.sync(() => {
      expect(ConfigDiagnostics.suggest("modell", ["model", "shell", "mcp"])).toBe("model")
      expect(ConfigDiagnostics.suggest("providers", ["model", "shell"])).toBeUndefined()
      expect(ConfigDiagnostics.suggest("model", ["model"])).toBeUndefined()
    }),
  )

  it.live("names the file, the key and the suggested fix for an unknown key", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const directory = path.join(tmp.path, "repo")
        return Effect.gen(function* () {
          // The layer reads the files when its graph is built, so discovery
          // must happen before it is provided, not inside the same generator.
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(path.join(directory, ".miao"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(global, "miao.json"), JSON.stringify({ model: "openrouter/model" })),
              fs.writeFile(path.join(directory, "miao.json"), JSON.stringify({ modell: "typo" })),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const explanation = yield* config.explain!()
            const broken = explanation.sources.find(
              (source) => source.origin.path === path.join(directory, "miao.json"),
            )
            expect(broken?.diagnostics).toEqual([
              expect.objectContaining({
                kind: "unknown-key",
                path: ["modell"],
                value: "typo",
                suggestion: "model",
              }),
            ])
            // The document still loads: an unknown key must not break the location.
            expect(Config.merge(yield* config.entries())).toMatchObject({ model: "openrouter/model" })
          }).pipe(Effect.provide(testLayer(directory, global)))
        })
      }),
    ),
  )
})
