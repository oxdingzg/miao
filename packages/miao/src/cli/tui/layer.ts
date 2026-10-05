import { run as runTui, type RemoteLocalFactory, type TuiInput } from "@miao/tui"
import { Global } from "@miao/core/global"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect } from "effect"
import { TerminalSession } from "./terminal-session"

export function run(input: TuiInput & { runtimeTarget?: TerminalSession.Runtime }) {
  return runTui({
    ...input,
    onSessionChange: input.onSessionChange ?? TerminalSession.reporter(input.runtimeTarget),
    remote: input.remote ?? remote,
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

// Relay account setup stays lazy and separate from session execution.
const remote: RemoteLocalFactory = async () => ({
  setup: async (input) => {
    const { HubSetup } = await import("@miao/remote-control/hub-setup")
    return HubSetup.connect(input)
  },
})
