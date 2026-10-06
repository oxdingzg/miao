import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppProcess } from "@miao/core/process"
import { Config } from "@miao/core/config"
import { ConfigLinter } from "@miao/core/config/linter"
import { Lint } from "@miao/core/lint"
import { Location } from "@miao/core/location"
import { AbsolutePath } from "@miao/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const runs: string[][] = []

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command) => {
      if (command._tag !== "StandardCommand") return Effect.die(new Error("expected standard command"))
      runs.push([command.command, ...command.args])
      if (command.command === "timeout-linter") return Effect.fail(new Error("spawn timed out"))
      const failed = command.command === "fail-linter"
      const verbose = command.args.includes("--verbose")
      const stderr = failed
        ? Buffer.from(verbose ? `${"lint issue ".repeat(400)}\n` : "mock lint failed\n")
        : Buffer.alloc(0)
      return Effect.succeed({
        command: "mock",
        exitCode: failed ? 1 : 0,
        output: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
        stderr,
        outputTruncated: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      })
    },
  } as unknown as AppProcess.Interface),
)

const withLint = <A, E, R>(entries: Config.Entry[], body: (lint: Lint.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
  )
  const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))
  const built = AppNodeBuilder.build(LayerNode.group([Lint.node]), [
    [Location.node, activeLocation],
    [Config.node, config],
    [AppProcess.node, appProcess],
  ])
  return Effect.gen(function* () {
    return yield* body(yield* Lint.Service)
  }).pipe(Effect.provide(built))
}

const entries = () =>
  new Config.Document({
    type: "document",
    info: new Config.Info({
      linter: {
        failing: new ConfigLinter.Entry({ command: ["fail-linter", "$FILE"], extensions: [".ts"] }),
        passing: new ConfigLinter.Entry({ command: ["pass-linter", "$FILE"], extensions: [".ts"] }),
        docs: new ConfigLinter.Entry({ command: ["fail-linter", "$FILE"], extensions: [".md"] }),
      },
    }),
  })

const it = testEffect(Layer.empty)

describe("Lint", () => {
  it.effect("reports only matching non-zero exits, with $FILE substituted", () =>
    withLint([entries()], (lint) =>
      Effect.gen(function* () {
        runs.length = 0
        const failures = yield* lint.file("/project/a.ts")
        expect(failures).toEqual([{ name: "failing", message: "mock lint failed" }])
        expect(runs).toEqual([
          ["fail-linter", "/project/a.ts"],
          ["pass-linter", "/project/a.ts"],
        ])
      }),
    ),
  )

  it.effect("keeps quiet when every matching linter passes", () =>
    withLint(
      [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            linter: { passing: new ConfigLinter.Entry({ command: ["pass-linter", "$FILE"], extensions: [".ts"] }) },
          }),
        }),
      ],
      (lint) =>
        Effect.gen(function* () {
          expect(yield* lint.file("/project/a.ts")).toEqual([])
        }),
    ),
  )

  it.effect("skips a linter whose run errors out", () =>
    withLint(
      [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            linter: { hung: new ConfigLinter.Entry({ command: ["timeout-linter", "$FILE"], extensions: [".ts"] }) },
          }),
        }),
      ],
      (lint) =>
        Effect.gen(function* () {
          expect(yield* lint.file("/project/a.ts")).toEqual([])
        }),
    ),
  )

  it.effect("caps a long lint message", () =>
    withLint(
      [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            linter: {
              failing: new ConfigLinter.Entry({
                command: ["fail-linter", "--verbose", "$FILE"],
                extensions: [".ts"],
              }),
            },
          }),
        }),
      ],
      (lint) =>
        Effect.gen(function* () {
          const [failure] = yield* lint.file("/project/a.ts")
          expect(failure?.message.startsWith("lint issue")).toBe(true)
          expect(failure?.message.endsWith("...")).toBe(true)
          expect(failure?.message.length).toBe(2_003)
        }),
    ),
  )
})
