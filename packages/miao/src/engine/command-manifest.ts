import type { Prompt, AgentAttachment } from "@miao/schema/prompt"
import type { agentManifest, modelRoute } from "./product-agent"

export type NativeAgentManifest = ReturnType<typeof agentManifest>
export type NativeAgentReferences = {
  catalog: readonly NativeAgentManifest[]
  mentions: readonly AgentAttachment[]
}

export type NativeCommand = NonNullable<Prompt["command"]> & {
  source?: string
  authority?: {
    default_agent?: string
    agent?: NativeAgentManifest
    model?: ReturnType<typeof modelRoute>
  }
}

export type NativeInput = {
  session_id: string
  input_id: string
  prompt: string
  delivery?: "steer" | "queue"
  command?: NativeCommand
  agent_references?: NativeAgentReferences
}
