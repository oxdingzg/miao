import { run as runTui, type RemoteLocalFactory, type TuiInput } from "@miao/tui"
import { Global } from "@miao/core/global"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui({ ...input, remote: input.remote ?? remote }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

// /remote's local logins and daemon start/stop live with `miao remote`; loaded only when the dialog needs them.
const remote: RemoteLocalFactory = async (settings) => {
  const { createRemoteLocal } = await import("../cmd/remote")
  return createRemoteLocal(settings)
}
