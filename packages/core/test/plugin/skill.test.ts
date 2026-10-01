import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { SkillPlugin } from "@miao/core/plugin/skill"
import { SkillV2 } from "@miao/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in skills", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-miao",
          description: expect.stringContaining("miao's own configuration"),
        }),
      )
      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "office-documents",
          content: expect.stringContaining("@deepseek-ai/libreoffice-kit@0.1.3"),
        }),
      )
    }),
  )
})
