import { SkillV2 } from "@miao/core/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { booted, response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers.handle("skill.list", () =>
    response(booted.pipe(Effect.andThen(SkillV2.Service.use((skill) => skill.list())))),
  ),
)
