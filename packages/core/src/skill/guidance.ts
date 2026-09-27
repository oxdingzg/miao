export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

// Every skill name is always listed; full descriptions are included only until
// this character budget is spent, so the base context does not grow with the
// number of installed skills.
const DESCRIPTION_BUDGET = 2_000

export const render = (skills: ReadonlyArray<Summary>) => {
  if (skills.length === 0)
    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      "No skills are currently available.",
    ].join("\n")

  let budget = DESCRIPTION_BUDGET
  let omitted = 0
  const lines: string[] = []
  for (const skill of skills) {
    const description = skill.description.trim()
    if (description.length > 0 && description.length <= budget) {
      budget -= description.length
      lines.push(
        "  <skill>",
        `    <name>${skill.name}</name>`,
        `    <description>${description}</description>`,
        "  </skill>",
      )
      continue
    }
    omitted += 1
    lines.push("  <skill>", `    <name>${skill.name}</name>`, "  </skill>")
  }

  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    ...(omitted > 0
      ? [`Descriptions are omitted for ${omitted} skill(s) past the context budget; load one by name to read it.`]
      : []),
  ].join("\n")
}

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* skills.list(), agent)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
