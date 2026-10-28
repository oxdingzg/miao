import { expect, test } from "bun:test"
import { engineArgs, engineEnvironment, type EngineOptions } from "../../src/engine/client"

const base: EngineOptions = { binary: "/bin/engine", db: "db", workspace: "/ws", model: "m" }

test("context limits ride the spawn args only when configured", () => {
  const plain = engineArgs(base)
  expect(plain).not.toContain("--context-limits")
  const configured = engineArgs({
    ...base,
    contextLimits: { window: 200_000, ratio: 0.85, headroom: 20_000, perPass: 50 },
  })
  const at = configured.indexOf("--context-limits")
  expect(at).toBeGreaterThan(-1)
  expect(JSON.parse(configured[at + 1]!)).toEqual({
    window: 200_000,
    ratio: 0.85,
    headroom: 20_000,
    perPass: 50,
  })
})

test("the prompt-cache policy rides the spawn args only when set", () => {
  expect(engineArgs(base)).not.toContain("--prompt-cache")
  const at = engineArgs({ ...base, promptCache: true }).indexOf("--prompt-cache")
  expect(engineArgs({ ...base, promptCache: true })[at + 1]).toBe("on")
  expect(engineArgs({ ...base, promptCache: false })[at + 1]).toBe("off")
})

test("the fallback model rides the spawn args only when configured", () => {
  expect(engineArgs(base)).not.toContain("--fallback-model")
  const configured = engineArgs({ ...base, fallbackModel: "glm-5.3-air" })
  const at = configured.indexOf("--fallback-model")
  expect(configured[at + 1]).toBe("glm-5.3-air")
})

test("purpose-role bindings ride the spawn args only when configured", () => {
  expect(engineArgs(base)).not.toContain("--role-summarize")
  const configured = engineArgs({
    ...base,
    roles: { summarize: "glm-5.3-flash", verify: "glm-5.3-air" },
  })
  const summarize = configured.indexOf("--role-summarize")
  expect(configured[summarize + 1]).toBe("glm-5.3-flash")
  expect(configured).not.toContain("--role-retrieve")
  const verify = configured.indexOf("--role-verify")
  expect(configured[verify + 1]).toBe("glm-5.3-air")
})

test("the completion check rides the spawn args only when configured", () => {
  expect(engineArgs(base)).not.toContain("--verify-command")
  const configured = engineArgs({ ...base, verifyCommand: "bun run check" })
  const at = configured.indexOf("--verify-command")
  expect(at).toBeGreaterThan(-1)
  expect(configured[at + 1]).toBe("bun run check")
})

test("the credential channel rides the spawn args only when configured", () => {
  expect(engineArgs(base)).not.toContain("--credential-db")
  const configured = engineArgs({
    ...base,
    credentialDatabase: "/home/u/.local/share/miao/miao.db",
    credentialID: "cred_1",
    credentialIntegration: "openai",
  })
  const at = configured.indexOf("--credential-db")
  expect(at).toBeGreaterThan(-1)
  expect(configured[at + 1]).toBe("/home/u/.local/share/miao/miao.db")
  expect(configured[configured.indexOf("--credential-id") + 1]).toBe("cred_1")
  expect(configured[configured.indexOf("--credential-integration") + 1]).toBe("openai")
})

test("the child inherits the engine's own surface and nothing else", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    TEMP: "/tmp",
    ANTHROPIC_API_KEY: "sk-ant-parent",
    EXA_API_KEY: "exa-parent",
    PARALLEL_API_KEY: "parallel-parent",
    MIAO_WEB_SEARCH_PROVIDER: "exa",
    MIAO_WEB_SEARCH_ENDPOINT: "https://search.example.test/search",
    MIAO_TOOL_INPUT_MAX_BYTES: "4096",
    AWS_SECRET_ACCESS_KEY: "aws-parent",
    AWS_ACCESS_KEY_ID: "aws-id-parent",
    AWS_PROFILE: "aws-profile-parent",
    AWS_REGION: "eu-west-1",
    AWS_BEARER_TOKEN_BEDROCK: "aws-bearer-parent",
    CI_JOB_TOKEN: "ci-parent",
    GH_TOKEN: "gh-parent",
  }
  const child = engineEnvironment({ OPENAI_API_KEY: "explicit" }, parent)
  expect(child.PATH).toBe("/usr/bin")
  expect(child.HOME).toBe("/home/u")
  expect(child.TEMP).toBe("/tmp")
  // The engine's own credential and knob surface crosses the boundary.
  expect(child.ANTHROPIC_API_KEY).toBe("sk-ant-parent")
  expect(child.EXA_API_KEY).toBe("exa-parent")
  expect(child.PARALLEL_API_KEY).toBe("parallel-parent")
  expect(child.MIAO_WEB_SEARCH_PROVIDER).toBe("exa")
  expect(child.MIAO_WEB_SEARCH_ENDPOINT).toBe("https://search.example.test/search")
  expect(child.MIAO_TOOL_INPUT_MAX_BYTES).toBe("4096")
  expect(child.OPENAI_API_KEY).toBe("explicit")
  // The AWS default chain is part of the supported Bedrock surface.
  expect(child.AWS_ACCESS_KEY_ID).toBe("aws-id-parent")
  expect(child.AWS_SECRET_ACCESS_KEY).toBe("aws-parent")
  expect(child.AWS_PROFILE).toBe("aws-profile-parent")
  expect(child.AWS_REGION).toBe("eu-west-1")
  expect(child.AWS_BEARER_TOKEN_BEDROCK).toBe("aws-bearer-parent")
  // Unrelated secrets in the operator's environment never reach the engine.
  expect(child.CI_JOB_TOKEN).toBeUndefined()
  expect(child.GH_TOKEN).toBeUndefined()
})

test("an explicit credential overrides an inherited value of the same name", () => {
  const child = engineEnvironment({ TEMP: "/explicit" }, { TEMP: "/parent", PATH: "/usr/bin" })
  expect(child.TEMP).toBe("/explicit")
  expect(child.PATH).toBe("/usr/bin")
})

test("the retained web-search provider knob reaches the engine under its own name", () => {
  const child = engineEnvironment(undefined, {
    EXA_API_KEY: "exa-parent",
    PARALLEL_API_KEY: "parallel-parent",
    MIAO_WEBSEARCH_PROVIDER: "parallel",
  })
  expect(child.MIAO_WEB_SEARCH_PROVIDER).toBe("parallel")
  expect(child.MIAO_WEBSEARCH_PROVIDER).toBeUndefined()
  // An environment already using the engine's name is authoritative.
  const current = engineEnvironment(undefined, {
    MIAO_WEB_SEARCH_PROVIDER: "exa",
    MIAO_WEBSEARCH_PROVIDER: "parallel",
  })
  expect(current.MIAO_WEB_SEARCH_PROVIDER).toBe("exa")
})

test("worker configuration diagnostics leave stdout available for protocols", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { engineArgs } from ${JSON.stringify(new URL("../../src/engine/client.ts", import.meta.url).href)}
    console.log(JSON.stringify(engineArgs({ binary: "engine", db: "db", workspace: "workspace", model: "model", workerConfigFile: "worker.json" })))
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit).toBe(0)
  expect(JSON.parse(stdout)).toContain("--worker-config")
  expect(stderr).toBe("")
})

test("the host configuration surface keeps each manifest in its own argv token", () => {
  const options = {
    ...base,
    configDir: "/config with spaces",
    configSources: JSON.stringify([{ type: "content", content: '{"model":"fixture"}' }]),
    policyFile: "/private/policy.json",
    mcpConfigFile: "/private/mcp.json",
    lspConfigFile: "/private/lsp.json",
    formatterConfigFile: "/private/formatter.json",
    contextConfigFile: "/private/context.json",
    skillsConfigFile: "/private/skills.json",
    referencesConfigFile: "/private/references.json",
    hooksConfigFile: "/private/hooks.json",
    modelRoutesConfigFile: "/private/routes.json",
    productToolsFile: "/private/tools.json",
    pluginHooksFile: "/private/plugin-hooks.json",
    workerConfigFile: "/private/worker.json",
    workspaceInstructions: false,
  }
  const args = engineArgs(options)
  const pairs = [
    ["--config-dir", options.configDir],
    ["--config-sources", options.configSources],
    ["--policy", options.policyFile],
    ["--mcp-config", options.mcpConfigFile],
    ["--lsp-config", options.lspConfigFile],
    ["--formatter-config", options.formatterConfigFile],
    ["--context-config", options.contextConfigFile],
    ["--skills-config", options.skillsConfigFile],
    ["--references-config", options.referencesConfigFile],
    ["--hooks-config", options.hooksConfigFile],
    ["--model-routes-config", options.modelRoutesConfigFile],
    ["--product-tools", options.productToolsFile],
    ["--plugin-hooks", options.pluginHooksFile],
    ["--worker-config", options.workerConfigFile],
    ["--workspace-instructions", "false"],
  ]
  expect(args.slice(0, 7)).toEqual(["serve", "--db", "db", "--workspace", "/ws", "--model", "m"])
  expect(args).toHaveLength(7 + 2 * pairs.length)
  for (const [flag, value] of pairs) {
    expect(args.filter((arg) => arg === flag)).toHaveLength(1)
    expect(args[args.indexOf(flag) + 1]).toBe(value)
    expect(engineArgs(base)).not.toContain(flag)
  }
})
