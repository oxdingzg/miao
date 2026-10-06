import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { BackgroundJob } from "@miao/core/background-job"
import { Database } from "@miao/core/database/database"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { EventV2 } from "@miao/core/event"
import { RuntimeActivity } from "@miao/core/runtime/activity"
import { SessionExecution } from "@miao/core/session/execution"
import { SessionProjector } from "@miao/core/session/projector"
import { SessionSchedule } from "@miao/core/session/schedule"
import { SessionStore } from "@miao/core/session/store"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionSchedule.node,
      BackgroundJob.node,
      RuntimeActivity.node,
    ]),
    [[SessionExecution.node, SessionExecution.noopLayer]],
  ),
)

describe("RuntimeActivity", () => {
  it.effect("reports an empty vector when nothing is running", () =>
    Effect.gen(function* () {
      const activity = yield* RuntimeActivity.Service
      expect(yield* activity.snapshot).toEqual({ executions: 0, unpromoted: 0, scheduled: 0, background: 0 })
    }),
  )
})
