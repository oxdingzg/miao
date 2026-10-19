export * as ProductCommand from "./product-command"

import { AgentV2 } from "@miao/core/agent"
import { SessionCommand } from "@miao/core/session/command"
import { Agent } from "@miao/schema/agent"
import type { Command } from "@miao/schema/command"
import type { AgentAttachment } from "@miao/schema/prompt"
import { Effect } from "effect"
import { EngineError } from "./client"
import { agentManifest, modelRoute, type Route } from "./product-agent"
import type { NativeAgentReferences, NativeCommand } from "./command-manifest"

/** Capture definition data only. The engine performs preparation after durable promotion. */
export const capture = Effect.fn("ProductCommand.capture")(function* (input: {
  definition: Command.Info
  arguments: string
  catalog: readonly Route[]
  sessionAgent?: string
}) {
  const agents = yield* AgentV2.Service
  const selected = input.definition.agent ? yield* agents.resolve(input.definition.agent) : undefined
  if (input.definition.agent && !selected)
    return yield* Effect.fail(new EngineError("command_agent_missing", "Command agent is not configured"))
  const fallback = yield* agents.default()
  const current = input.sessionAgent ? yield* agents.resolve(input.sessionAgent) : fallback
  const directory = (yield* agents.all())
    .filter((agent) => agent.permission_mode !== "auto" || agent.id === selected?.id || agent.id === fallback?.id)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  // Host-only model routes remain outside the native catalog. An explicitly
  // requested/default agent is checked strictly below rather than substituted.
  const definitions = yield* Effect.forEach(directory, (agent) =>
    Effect.try({ try: () => agentManifest(agent, input.catalog), catch: (error) => error }).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  )
  return yield* Effect.try({
    try: () => {
      if (fallback && !input.sessionAgent && !selected) agentManifest(fallback, input.catalog)
      const command: NativeCommand = {
        name: input.definition.name,
        arguments: input.arguments,
        ...(input.definition.agent ? { agent: Agent.ID.make(input.definition.agent) } : {}),
        ...(input.definition.model ? { model: input.definition.model } : {}),
        subtask: input.definition.subtask ?? (selected ?? current)?.mode === "subagent",
        authority: {
          ...(fallback && definitions.some((agent) => agent?.name === fallback.id)
            ? { default_agent: fallback.id }
            : {}),
          ...(selected ? { agent: agentManifest(selected, input.catalog) } : {}),
          ...(input.definition.model ? { model: modelRoute(input.definition.model, input.catalog) } : {}),
        },
      }
      return {
        text: SessionCommand.renderTemplate(input.definition.template, input.arguments),
        command,
        agentReferences: { catalog: definitions.filter((agent) => agent !== undefined), mentions: [] },
      }
    },
    catch: (error) => error,
  })
})

export const references = Effect.fn("ProductCommand.references")(function* (
  mentions: readonly AgentAttachment[],
  catalog: readonly Route[],
) {
  const agents = yield* AgentV2.Service
  const names = [...new Set(mentions.map((mention) => mention.name))].sort()
  const definitions = yield* Effect.forEach(names, (name) =>
    agents
      .resolve(name)
      .pipe(
        Effect.flatMap((agent) =>
          agent
            ? Effect.try({ try: () => agentManifest(agent, catalog), catch: (error) => error })
            : Effect.fail(new EngineError("agent_reference_missing", `Agent reference is not configured: ${name}`)),
        ),
      ),
  )
  return { catalog: definitions, mentions } satisfies NativeAgentReferences
})
