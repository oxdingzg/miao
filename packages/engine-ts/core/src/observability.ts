export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization } from "effect/unstable/observability"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    // The file logger's batch buffer flushes when this scope closes, so it
    // must be built inside the layer's own construction scope.
    const file = yield* Logging.fileLogger()
    const fileLoggers = Logging.printLogs() ? [file, Logging.stderrLogger] : [file]
    const logs = Logger.layer([...fileLoggers, ...Otlp.loggers()], { mergeWithExisting: false }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    return Layer.merge(logs, yield* Effect.promise(Otlp.tracingLayer))
  }),
)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })
