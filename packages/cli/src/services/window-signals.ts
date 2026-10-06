import { Effect, Layer } from "effect"

/** NodeRuntime already interrupts SIGINT/SIGTERM; terminal hangup uses the same scope closure. */
export const layer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      const close = () => process.emit("SIGTERM")
      process.once("SIGHUP", close)
      return close
    }),
    (close) => Effect.sync(() => process.off("SIGHUP", close)),
  ),
)
