import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Config } from "@miao/core/config"
import { ConfigProvider } from "@miao/core/config/provider"
import { AppNodeBuilder } from "@miao/core/effect/app-node-builder"
import { LayerNode } from "@miao/core/effect/layer-node"
import { ConfigMigrateV1 } from "@miao/core/v1/config/migrate"
import { ConfigV1 } from "@miao/core/v1/config/config"
import { FSUtil } from "@miao/core/fs-util"
import { Global } from "@miao/core/global"
import { Location } from "@miao/core/location"
import { Policy } from "@miao/core/policy"
import { Project } from "@miao/core/project"
import { AbsolutePath } from "@miao/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const provider = {
  api: { type: "native", settings: {} },
  request: {
    headers: {},
    body: {},
  },
  models: {},
}

describe("Config", () => {
  it.effect("returns the latest defined scalar from priority-ordered documents", () =>
    Effect.sync(() => {
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5" }) }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
        new Config.Document({ type: "document", info: new Config.Info({}) }),
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5.5" }) }),
      ]

      expect(Config.latest(entries, "model")).toBe("openrouter/openai/gpt-5.5")
      expect(Config.latest(entries, "default_agent")).toBeUndefined()
    }),
  )

  it.effect("detects v1 configuration from any v1-only top-level key", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.isV1({ snapshot: false })).toBe(true)
      expect(ConfigMigrateV1.isV1({ snapshot: false, agents: {} })).toBe(true)
      expect(ConfigMigrateV1.isV1({ reference: {} })).toBe(true)
      expect(ConfigMigrateV1.isV1({ shell: "/bin/zsh", model: "anthropic/claude" })).toBe(false)
      expect(ConfigMigrateV1.isV1({ references: {} })).toBe(false)
    }),
  )

  it.effect("migrates disabled providers onto their V2 provider entries", () =>
    Effect.sync(() => {
      const migrated = Schema.decodeUnknownSync(Config.Info)(
        ConfigMigrateV1.migrate(
          Schema.decodeUnknownSync(ConfigV1.Info)({
            provider: { custom: { name: "Custom" } },
            disabled_providers: ["custom", "openai"],
          }),
        ),
      )
      expect(migrated.providers?.custom).toMatchObject({ name: "Custom", disabled: true })
      expect(migrated.providers?.openai).toMatchObject({ disabled: true })
    }),
  )

  it.effect("migrates arbitrary v1 configuration into valid v2 configuration", () =>
    Effect.sync(() => {
      FastCheck.assert(
        FastCheck.property(Schema.toArbitrary(ConfigV1.Info), (info) => {
          Schema.decodeUnknownSync(Config.Info)(ConfigMigrateV1.migrate(info), { errors: "all" })
        }),
        { numRuns: 100 },
      )
    }),
  )

  it.effect("migrates v1 provider setup options into AISDK settings", () =>
    Effect.sync(() => {
      const migrated = ConfigMigrateV1.migrate({
        provider: {
          bedrock: {
            npm: "@ai-sdk/amazon-bedrock",
            options: {
              headers: { "x-test": "1" },
              body: { trace: true },
              region: "us-east-1",
              profile: "dev",
            },
          },
        },
      })

      expect(migrated.providers?.bedrock?.api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/amazon-bedrock",
        settings: { region: "us-east-1", profile: "dev" },
      })
      expect(migrated.providers?.bedrock?.request).toEqual({
        headers: { "x-test": "1" },
        body: { trace: true },
      })
    }),
  )

  it.effect("migrates v1 command configuration", () =>
    Effect.sync(() => {
      expect(
        ConfigMigrateV1.migrate({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask: true,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: "anthropic/claude",
          variant: "high",
          subtask: true,
        },
      })
    }),
  )

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()

          expect(entries).toEqual([
            new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("loads sandbox settings from V2 and migrated V1 documents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sandbox = {
            mode: "workspace-write",
            network: false,
            writable_roots: ["~/.cache"],
            on_unavailable: "fail",
          } as const
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "global"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "global", "miao.json"),
              JSON.stringify({ permission: { bash: "ask" }, sandbox: { mode: "off", writable_roots: ["build"] } }),
            ),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "miao.json"), JSON.stringify({ sandbox })))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents.map((document) => document.info.sandbox)).toEqual([
              { mode: "off", writable_roots: ["build"] },
              sandbox,
            ])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads remote settings from V2 and migrated V1 documents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const remote = {
            port: 4097,
            projects: { miao: "~/workspace/code/github/miao" },
            wechat: { push_budget_per_day: 2 },
          }
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "global"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "global", "miao.json"),
              JSON.stringify({ permission: { bash: "ask" }, remote: { port: 5000 } }),
            ),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "miao.json"), JSON.stringify({ remote })))
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents.map((document) => document.info.remote)).toEqual([{ port: 5000 }, remote])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads opencode JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "miao.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "miao.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Config.Document)
            expect(documents[0]?.path).toBe(path.join(tmp.path, "miao.json"))
            expect(documents[1]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "miao.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "miao.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.experimental?.policies?.[0]).toEqual({
              effect: "deny",
              action: "provider.use",
              resource: "openai",
            })
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "miao.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                autoupdate: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5",
                    variant: "high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "warning",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                attachments: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                mcp: {
                  timeout: { startup: 5000, request: 60000 },
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      timeout: { request: 10000 },
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                      timeout: { startup: 15000 },
                    },
                  },
                },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
                plugins: [
                  "opencode-helicone-session",
                  { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
                ],
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toBe("anthropic/claude")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.autoupdate).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toBe("openrouter/openai/gpt-5")
            expect(reviewer?.variant).toBe("high")
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("warning")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.attachments).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: { startup: 5000, request: 60000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  timeout: { request: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                  timeout: { startup: 15000 },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: false,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              ".cursor/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
            expect(documents[0]?.info.plugins).toEqual([
              "opencode-helicone-session",
              { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates the deprecated reference key into references", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "miao.json"),
              JSON.stringify({
                reference: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "miao.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                snapshot: false,
                autoshare: true,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    temperature: 0.2,
                    permission: { read: "allow" },
                  },
                },
                plugin: [
                  "opencode-helicone-session",
                  ["@my-org/audit-plugin", { endpoint: "https://audit.example.com" }],
                ],
                skills: { paths: ["./skills"], urls: ["https://example.com/.well-known/skills/"] },
                references: {
                  docs: { path: "../docs", description: "Use for product documentation", hidden: true },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                provider: {
                  custom: {
                    options: { apiKey: "secret" },
                    models: {
                      model: {
                        options: { reasoningEffort: "high" },
                        variants: { fast: { temperature: 0.2 } },
                      },
                    },
                  },
                  openai: {
                    npm: "@ai-sdk/openai",
                    options: { apiKey: "secret", organization: "org" },
                    models: {
                      model: {
                        options: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                        variants: { high: { reasoningEffort: "high", reasoningSummary: "auto" } },
                      },
                    },
                  },
                  anthropic: {
                    npm: "@ai-sdk/anthropic",
                    models: {
                      model: {
                        options: {
                          effort: "high",
                          taskBudget: 4096,
                          metadata: { userId: "user-1" },
                        },
                      },
                    },
                  },
                },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
                experimental: { mcp_timeout: 5000 },
                mcp: {
                  local: { type: "local", command: ["node", "server.js"], enabled: false, timeout: 10000 },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    oauth: { clientId: "client", callbackPort: 19876 },
                    timeout: 20000,
                  },
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Config.Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.share).toBe("auto")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "question", resource: "*", effect: "deny" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              request: { body: { temperature: 0.2 } },
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.plugins).toEqual([
              "opencode-helicone-session",
              { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
            ])
            expect(documents[0]?.info.skills).toEqual(["./skills", "https://example.com/.well-known/skills/"])
            expect(documents[0]?.info.references).toEqual({
              docs: { path: "../docs", description: "Use for product documentation", hidden: true },
            })
            expect(documents[0]?.info.attachments).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            expect(documents[0]?.info.providers?.custom).toMatchObject({
              request: { body: { apiKey: "secret" } },
              models: {
                model: {
                  request: { body: { reasoningEffort: "high" } },
                  variants: [{ id: "fast", body: { temperature: 0.2 } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.openai).toMatchObject({
              api: { settings: {} },
              request: { headers: { Authorization: "Bearer secret", "OpenAI-Organization": "org" } },
              models: {
                model: {
                  request: {
                    body: { temperature: 0.3, reasoning: { effort: "high" }, service_tier: "priority" },
                  },
                  variants: [{ id: "high", body: { reasoning: { effort: "high", summary: "auto" } } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.anthropic).toMatchObject({
              models: {
                model: {
                  request: {
                    body: {
                      output_config: { effort: "high", task_budget: 4096 },
                      metadata: { user_id: "user-1" },
                    },
                  },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: undefined,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.mcp).toMatchObject({
              timeout: { request: 5000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "server.js"],
                  disabled: true,
                  timeout: { request: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com",
                  oauth: { client_id: "client", callback_port: 19876 },
                  timeout: { request: 20000 },
                },
              },
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "miao.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "miao.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads policy statements in reverse config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(
              path.join(global, "miao.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
              }),
            )
            await fs.writeFile(
              path.join(tmp.path, "miao.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "allow", action: "provider.use", resource: "openai" }] },
              }),
            )
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service

            expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )

  it.live("loads global, ancestor, and .miao configuration up to the project boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".miao"), { recursive: true })
            await fs.mkdir(path.join(directory, ".miao"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "miao.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "miao.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "miao.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "miao.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "miao.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".miao", "miao.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(path.join(directory, ".miao", "miao.jsonc"), JSON.stringify({ $schema: "directory-dot" })),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".miao")),
              AbsolutePath.make(path.join(directory, ".miao")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              "global",
              AbsolutePath.make(global),
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".miao")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".miao")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )
  it.live("applies the MIAO_CONFIG, MIAO_CONFIG_DIR, and MIAO_CONFIG_CONTENT overrides in V1 order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const directory = path.join(tmp.path, "repo")
        const customFile = path.join(tmp.path, "custom.json")
        const customDirectory = path.join(tmp.path, "custom-dir")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(path.join(directory, ".miao"), { recursive: true })
            await fs.mkdir(customDirectory, { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(global, "miao.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(customFile, JSON.stringify({ $schema: "custom-file" })),
              fs.writeFile(path.join(directory, "miao.json"), JSON.stringify({ $schema: "project" })),
              fs.writeFile(path.join(directory, ".miao", "miao.json"), JSON.stringify({ $schema: "project-dot" })),
              fs.writeFile(path.join(customDirectory, "miao.json"), JSON.stringify({ $schema: "custom-dir" })),
            ])
          })
          const loaded = () =>
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              return entries.flatMap((entry) => (entry.type === "document" ? [entry.info.$schema] : []))
            }).pipe(Effect.provide(testLayer(directory, global)))

          expect(
            yield* withEnv(
              {
                MIAO_CONFIG: customFile,
                MIAO_CONFIG_DIR: customDirectory,
                MIAO_CONFIG_CONTENT: JSON.stringify({ $schema: "content" }),
                MIAO_DISABLE_PROJECT_CONFIG: undefined,
              },
              loaded,
            ),
          ).toEqual(["global", "custom-file", "project", "project-dot", "custom-dir", "content"])
          expect(
            yield* withEnv(
              {
                MIAO_CONFIG: undefined,
                MIAO_CONFIG_DIR: undefined,
                MIAO_CONFIG_CONTENT: undefined,
                MIAO_DISABLE_PROJECT_CONFIG: "1",
              },
              loaded,
            ),
          ).toEqual(["global"])
        })
      }),
    ),
  )
})
