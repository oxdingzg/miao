import type { ToolDefinition } from "../../tool.js"
import type { ToolAfterEvent, ToolBeforeEvent, ToolDefinitionEvent } from "../effect/tool.js"
import type { Registration } from "./registration.js"

export type { ToolAfterEvent, ToolBeforeEvent, ToolDefinitionEvent }

type ToolHook<Event> = (callback: (event: Event) => Promise<void> | void) => Promise<Registration>

/** Promise flavor of the V2 tool hooks; see `@opencode-ai/plugin/v2/effect` for semantics. */
export interface ToolHooks {
  /** Runs before every tool call. Throwing rejects the call with a model-visible error. */
  readonly before: ToolHook<ToolBeforeEvent>
  /** Runs after a successful tool call. Throwing turns the result into a model-visible error. */
  readonly after: ToolHook<ToolAfterEvent>
  /** Rewrites a tool's description or input schema; a throwing hook is logged and skipped. */
  readonly definition: ToolHook<ToolDefinitionEvent>
  /** Registers `tool({ ... })` definitions as tools for this location until the plugin unloads. */
  readonly register: (tools: Record<string, ToolDefinition>) => Promise<Registration>
}
