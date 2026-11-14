import type { Effect, Scope } from "effect"
import type { ToolDefinition } from "../../tool.js"
import type { Registration } from "./registration.js"

/**
 * V2 tool hooks. These replace the legacy `Hooks["tool.execute.before"]`,
 * `Hooks["tool.execute.after"]`, `Hooks["tool.definition"]` and `Hooks.tool`,
 * which V2 sessions never call.
 */
export interface ToolBeforeEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly agent: string
  /** Raw tool input. Replace it to change what the tool receives. */
  args: any
}

export interface ToolAfterEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly agent: string
  readonly args: any
  /** Kept for V1 parity; V2 tools have no title and changes are ignored. */
  title: string
  /** Model-facing text of the result. Replacing it replaces the text content. */
  output: string
  /** The tool's structured output. Replacing it replaces the structured result. */
  metadata: any
}

export interface ToolDefinitionEvent {
  readonly tool: string
  description: string
  /** JSON Schema of the tool input. */
  parameters: any
}

type ToolHook<Event> = (
  callback: (event: Event) => Effect.Effect<void, unknown> | void,
) => Effect.Effect<Registration, never, Scope.Scope>

export interface ToolHooks {
  /** Runs before every tool call. Failing (or throwing) rejects the call with a model-visible error. */
  readonly before: ToolHook<ToolBeforeEvent>
  /** Runs after a successful tool call. Failing (or throwing) turns the result into a model-visible error. */
  readonly after: ToolHook<ToolAfterEvent>
  /** Rewrites a tool's description or input schema; a failing hook is logged and skipped. */
  readonly definition: ToolHook<ToolDefinitionEvent>
  /** Registers `tool({ ... })` definitions as tools for this location until the plugin unloads. */
  readonly register: (tools: Record<string, ToolDefinition>) => Effect.Effect<Registration, never, Scope.Scope>
}
