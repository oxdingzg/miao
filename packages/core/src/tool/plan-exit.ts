/**
 * Plan-exit and plan-enter both move through one user-approved, durable
 * Session agent switch. The shared implementation lives in `plan-approval`;
 * this module keeps the plan-exit identity and its existing exports.
 */
export * as PlanExitTool from "./plan-exit"

export { EXIT, Input, Output } from "./plan-approval"
export const name = "plan_exit"
export const node = makeNode()

import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { EventV2 } from "../event"
import { SessionStore } from "../session/store"
import { PlanApprovalTool } from "./plan-approval"

function makeNode() {
  return makeLocationNode({
    name: "tool/plan-exit",
    layer: PlanApprovalTool.exitLayer,
    deps: [ToolRegistry.node, PermissionV2.node, QuestionV2.node, EventV2.node, SessionStore.node],
  })
}
