import { expect } from "bun:test"
import { stat } from "node:fs/promises"
import { Config } from "@miao/core/config"
import { Location } from "@miao/core/location"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { Formatter } from "@miao/core/format/registry"
import { Effect, Layer, Schema } from "effect"
import { ProductFormatter } from "../../src/engine/product-formatter"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const it = testEffect(Layer.empty)

it.live("native formatters inherit commands, extensions and environment in a private scoped manifest", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const disabled = Object.fromEntries(
      Object.values(Formatter).flatMap((formatter) =>
        typeof formatter === "object" && formatter !== null && "name" in formatter
          ? [[formatter.name, { disabled: true }]]
          : [],
      ),
    )
    const file = yield* Effect.scoped(
      Effect.gen(function* () {
        const options = yield* ProductFormatter.prepare(location, { binary: "fixture", model: "fixture" })
        const file = options.formatterConfigFile
        if (!file) throw new Error("missing formatter manifest")
        expect(yield* Effect.promise(() => Bun.file(file).json())).toEqual([
          {
            name: "fixture",
            argv: [process.execPath, "format", "$FILE"],
            extensions: [".fixture"],
            env: { FMT: "enabled" },
          },
        ])
        if (process.platform !== "win32") expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
        return file
      }).pipe(
        Effect.provideService(Config.Service, {
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: Schema.decodeUnknownSync(Config.Info)({
                  formatter: {
                    ...disabled,
                    fixture: {
                      command: [process.execPath, "format", "$FILE"],
                      extensions: [".fixture"],
                      environment: { FMT: "enabled" },
                    },
                  },
                }),
              }),
            ]),
        }),
        Effect.provideService(Location.Service, {
          ...location,
          project: { id: Project.ID.global, directory: location.directory },
        }),
      ),
    )
    expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
  }),
)

it.live("explicit native formatter manifest takes precedence without product services", () =>
  Effect.gen(function* () {
    const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
    expect(
      yield* ProductFormatter.prepare(location, {
        binary: "fixture",
        model: "fixture",
        formatterConfigFile: "/operator/formatter.json",
      }),
    ).toEqual({})
  }),
)
