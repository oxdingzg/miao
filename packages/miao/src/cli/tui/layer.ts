import { run as runTui, type TuiInput } from "@miao/tui"
import { Global } from "@miao/core/global"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
