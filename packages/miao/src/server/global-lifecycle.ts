import { GlobalBus } from "@/bus/global"
import { Event } from "./event"

/** Tell local listeners (the TUI worker bridge) that global state was invalidated. */
export const emitGlobalDisposed = () =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  })

export * as GlobalLifecycle from "./global-lifecycle"
