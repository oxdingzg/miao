// Plugin authoring surface, kept free of runtime imports. Built-in provider
// plugins import `define` from here instead of `./internal`: `./internal` imports
// `./provider`, whose top-level `ProviderPlugins` array reads every provider
// binding. Entering a provider module first (e.g. importing it directly) would
// otherwise evaluate that array while the entry module is still uninitialized.
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import type { Effect, Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { AgentV2 } from "../agent"
import type { Catalog } from "../catalog"
import type { CommandV2 } from "../command"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import type { FileSystem } from "../filesystem"
import type { FSUtil } from "../fs-util"
import type { Global } from "../global"
import type { Integration } from "../integration"
import type { Location } from "../location"
import type { ModelsDev } from "../models-dev"
import type { Npm } from "../npm"
import type { Reference } from "../reference"
import type { SkillV2 } from "../skill"

export type Requirements =
  | AgentV2.Service
  | Catalog.Service
  | CommandV2.Service
  | Config.Service
  | EventV2.Service
  | FileSystem.Service
  | FSUtil.Service
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelsDev.Service
  | Npm.Service
  | Reference.Service
  | SkillV2.Service

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}
