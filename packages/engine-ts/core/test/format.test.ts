import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppProcess } from "@miao/core/process"
import { Config } from "@miao/core/config"
import { ConfigFormatter } from "@miao/core/config/formatter"
import { Format } from "@miao/core/format"
import { Location } from "@miao/core/location"
import { AbsolutePath } from "@miao/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const runs: string[][] = []

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        runs.push([command.command, ...command.args])
        return {
          command: "mock",
          exitCode: 0,
          output: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          outputTruncated: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
  } as unknown as AppProcess.Interface),
)

const withFormat = <A, E, R>(
  entries: Config.Entry[],
  body: (format: Format.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
  )
  const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))
  const built = AppNodeBuilder.build(LayerNode.group([Format.node]), [
    [Location.node, activeLocation],
    [Config.node, config],
    [AppProcess.node, appProcess],
  ])
  return Effect.gen(function* () {
    return yield* body(yield* Format.Service)
  }).pipe(Effect.provide(built))
}

const it = testEffect(Layer.empty)

describe("Format", () => {
  it.effect("does nothing when no formatter is configured", () =>
    withFormat([], (format) =>
      Effect.gen(function* () {
        expect(yield* format.file("/project/a.txt")).toBe(false)
        expect(runs).toEqual([])
      }),
    ),
  )

  it.effect("runs a configured command for matching extensions with $FILE substituted", () =>
    withFormat(
      [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            formatter: {
              "test-fmt": new ConfigFormatter.Entry({
                command: ["fmt", "--write", "$FILE"],
                extensions: [".txt"],
              }),
            },
          }),
        }),
      ],
      (format) =>
        Effect.gen(function* () {
          expect(yield* format.file("/project/a.txt")).toBe(true)
          expect(runs).toEqual([["fmt", "--write", "/project/a.txt"]])
        }),
    ),
  )
})
