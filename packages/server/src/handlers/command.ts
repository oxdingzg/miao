import { CommandV2 } from "@miao/core/command"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { booted, response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () =>
    response(booted.pipe(Effect.andThen(CommandV2.Service.use((command) => command.list())))),
  ),
)
