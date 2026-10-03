import type { Agent, AgentV2Info, Command, CommandV2Info, Provider } from "@opencode-ai/sdk/v2"

// The full provider catalog in the V1 provider-list shape the TUI keeps.
export type ProviderCatalog = { all: Provider[]; default: Record<string, string>; connected: string[] }

// The V2 agent shape carries `id` and `permissions`; the TUI store still keeps
// the V1 Agent shape, and no consumer reads the ruleset, so map the fields used.
export function toAgent(agent: AgentV2Info): Agent {
  return {
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    color: agent.color,
    steps: agent.steps,
    model: agent.model ? { modelID: agent.model.id, providerID: agent.model.providerID } : undefined,
    variant: agent.model?.variant,
    permission: [],
    options: {},
  }
}

// V2 serves providers as the legacy V1 shape but with a permissive schema until
// the V2 provider/model schemas move into Schema; keep the store shape the TUI
// already reads.
export function toProviderList(raw: { providers: unknown[]; default: Record<string, string> }) {
  return raw as unknown as { providers: Provider[]; default: Record<string, string> }
}

// V2 commands carry a model ref and no hints; the TUI store still keeps the V1
// Command shape and renders no hints.
export function toCommand(command: CommandV2Info): Command {
  return {
    name: command.name,
    description: command.description,
    agent: command.agent,
    model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
    template: command.template,
    subtask: command.subtask,
    hints: [],
  }
}

// V2 serves the full catalog as the legacy V1 provider-list shape but with a
// permissive schema until the V2 provider/model schemas move into Schema; keep
// the store shape the TUI already reads.
export function toProviderCatalog(raw: {
  all: unknown[]
  default: Record<string, string>
  connected: string[]
}): ProviderCatalog {
  return raw as unknown as ProviderCatalog
}
