/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-miao.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-miao",
            description:
              "Use ONLY when the user is editing or creating miao's own configuration: miao.json, miao.jsonc, files under .miao/, or files under ~/.config/miao/. Also use when creating or fixing miao agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring miao itself.",
            location: AbsolutePath.make("/builtin/customize-miao.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
