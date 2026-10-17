export * as Config from "./config"

import { Schema } from "effect"
import { Permission } from "@miao/schema/permission"
import { AbsolutePath, optional } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCache } from "./config/cache"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigCost } from "./config/cost"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLinter } from "./config/linter"
import { ConfigTools } from "./config/tools"
import { ConfigLSP } from "./config/lsp"
import { ConfigLoop } from "./config/loop"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigSandbox } from "./config/sandbox"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"

// The V2 config schema, shared so clients can type /api/config against it.
/** Deployment assertions for optional Responses cache controls; validated by the engine before transport. */
export class ResponsesCacheContract extends Schema.Class<ResponsesCacheContract>("Config.ResponsesCacheContract")({
  model: Schema.String,
  endpoint: Schema.String,
  authentication: Schema.Literals(["api", "subscription"]),
  profile: Schema.Literals(["legacy", "breakpoints"]),
  mode: optional(Schema.Literals(["implicit", "explicit", "disabled"])),
  ttl: optional(Schema.Literal("30m")),
  retention: optional(Schema.Literals(["in_memory", "24h"])),
  system: optional(Schema.Boolean),
  prewarm: optional(Schema.Literal(false)),
}) {}

/**
 * Engine process settings (B1): read from the **global** config file only —
 * the engine is one process serving every Location, so project documents do
 * not configure it. The operator's environment overrides any key.
 */
export class Engine extends Schema.Class<Engine>("Config.Engine")({
  tool_disclosure: optional(Schema.Literals(["full", "compact"])).annotate({
    description: "Extension tool disclosure: full schemas (default) or stable search/call bridge",
  }),
  provider: Schema.String.pipe(Schema.optional).annotate({
    description: "Provider id the engine's primary model resolves against",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "The engine's primary model id",
  }),
  endpoint: Schema.String.pipe(Schema.optional).annotate({
    description: "Provider endpoint override for the engine's route",
  }),
  fallback_model: Schema.String.pipe(Schema.optional).annotate({
    description: "Model id retried once when the primary route fails at the transport level",
  }),
  roles: Schema.Struct({
    summarize: Schema.String.pipe(Schema.optional),
    retrieve: Schema.String.pipe(Schema.optional),
    verify: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Purpose-role model bindings (ADR-14), resolved on the engine's own route",
    }),
  prompt_cache: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Prompt-cache policy for providers that support it (default provider-dependent)",
  }),
  responses_cache_contract: optional(ResponsesCacheContract).annotate({
    description:
      "Explicit Responses cache capability bound to model, endpoint and authentication; absent preserves existing requests",
  }),
  verify_command: Schema.String.pipe(Schema.optional).annotate({
    description: "Completion check the engine runs before ending an edit turn",
  }),
  mcp_config: optional(Schema.String).annotate({
    description:
      "Native engine MCP host configuration file; relative paths resolve against the global config directory",
  }),
  lsp_config: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Native engine LSP host configuration file; relative paths resolve against the global config directory",
  }),
  context_limits: Schema.Struct({
    window: Schema.Finite,
    ratio: Schema.Finite,
    headroom: Schema.Finite,
    perPass: Schema.Finite,
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Automatic compaction trigger (roadmap §2.13); absent keeps it off",
    }),
}) {}

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  engine: Engine.pipe(Schema.optional).annotate({
    description: "Engine process settings (global config file only; environment overrides)",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "@deprecated Ignored: session sharing was removed",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "@deprecated Ignored: session sharing was removed",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  disabled_tools: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Tool names hidden from the model for every agent in this Location",
  }),
  accounts: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
    description: "Account a provider should use, keyed by provider id and valued by credential label or id",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  linter: ConfigLinter.Info.pipe(Schema.optional).annotate({
    description: "File-scoped lint commands that run after edits and feed failures back to the model",
  }),
  tools: ConfigTools.Info.pipe(Schema.optional).annotate({
    description: "Tool advertising: defer remote catalogs behind tool_search and pin always-loaded tools",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  cache: ConfigCache.Info.pipe(Schema.optional).annotate({
    description: "Prompt cache behavior",
  }),
  loop: ConfigLoop.Info.pipe(Schema.optional).annotate({
    description: "Goal/todo-driven autonomous loop that continues the session until todos complete",
  }),
  cost: ConfigCost.Info.pipe(Schema.optional).annotate({
    description: "Cost guardrails",
  }),
  sandbox: ConfigSandbox.Info.pipe(Schema.optional).annotate({
    description: "OS sandbox for bash commands",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory
