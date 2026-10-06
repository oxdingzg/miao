/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-miao.md" with { type: "text" }
import officeDocumentsContent from "./skill/office-documents.md" with { type: "text" }
import mediaObserveContent from "./skill/media-observe.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const OfficeDocumentsContent = officeDocumentsContent
export const MediaObserveContent = mediaObserveContent
export const MediaObserveDescription =
  "Use when a task involves a video or audio file: understanding footage, finding moments, building or checking a video edit, extracting frames, or verifying a render. Turns media into timestamped contact sheets with ffmpeg and reads those instead of guessing from metadata."

export const OfficeDocumentsDescription =
  "Use when creating, editing, converting or checking Word, Excel or PowerPoint files (.docx, .xlsx, .pptx, .doc, .xls, .ppt), exporting them to PDF, or rendering their pages to images to verify fonts and layout, especially documents with Chinese text. For rendering, PDF export and font checks, follow this skill instead of any other skill's soffice/LibreOffice steps."

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
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "office-documents",
            description: OfficeDocumentsDescription,
            location: AbsolutePath.make("/builtin/office-documents.md"),
            content: OfficeDocumentsContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "media-observe",
            description: MediaObserveDescription,
            location: AbsolutePath.make("/builtin/media-observe.md"),
            content: MediaObserveContent,
          }),
        }),
      )
    })
  }),
})
