import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJobTool } from "@miao/core/tool/background-job"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("BackgroundJobTool", () => {
  it.effect("exposes the list, wait, and cancel tools", () =>
    Effect.sync(() => {
      const tools = BackgroundJobTool.make({
        list: () => Effect.succeed([]),
        wait: () => Effect.succeed({ timedOut: false }),
        cancel: () => Effect.succeed(undefined),
      })
      expect(Object.keys(tools).toSorted()).toEqual(["job_cancel", "job_list", "job_wait"])
    }),
  )
})
