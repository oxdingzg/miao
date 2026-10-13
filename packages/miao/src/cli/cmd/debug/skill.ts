import { EOL } from "os"
import { Effect } from "effect"
import { Location } from "@miao/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@miao/core/location-services"
import { AbsolutePath } from "@miao/core/schema"
import { SkillV2 } from "@miao/core/skill"
import { effectCmd } from "../../effect-cmd"

export const SkillCommand = effectCmd({
  command: "skill",
  describe: "list all available skills",
  instance: false,
  builder: (yargs) => yargs,
  handler: () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      const skills = yield* skill.list()
      process.stdout.write(JSON.stringify(skills, null, 2) + EOL)
    }).pipe(
      Effect.withSpan("Cli.debug.skill"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    ),
})
