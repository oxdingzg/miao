import { expect, test } from "bun:test"
import path from "node:path"
import { existsSync, statSync } from "node:fs"
import { Schema } from "effect"
import { ConfigMCP } from "@miao/schema/config/mcp"
import { prepareMcpConfig } from "@/engine/mcp-config"
import { tmpdir } from "../fixture/fixture"

const local = Schema.decodeUnknownSync(ConfigMCP.Info)({
  servers: {
    fixture: { type: "local", command: ["node", "peer.js"], environment: { FIXTURE_KEY: "fixture-value" } },
    disabled: { type: "remote", url: "https://example.invalid/mcp", disabled: true },
  },
})

test("shared MCP attachment requires explicit native workspace authority", async () => {
  await using tmp = await tmpdir()
  const options = { binary: "unused", model: "unused", db: "unused", workspace: tmp.path, mcpSettings: local }
  expect(prepareMcpConfig(options)).toBeUndefined()
  const policyFile = path.join(tmp.path, "policy.json")
  await Bun.write(policyFile, JSON.stringify({ mode: "workspace", allow_mcp: false }))
  expect(prepareMcpConfig({ ...options, policyFile })).toBeUndefined()
  await Bun.write(policyFile, JSON.stringify({ mode: "readonly", allow_mcp: true }))
  expect(prepareMcpConfig({ ...options, policyFile })).toBeUndefined()
  expect(prepareMcpConfig({ ...options, policyFile, mcpConfigFile: "operator.json" })).toBeUndefined()
})

test("shared local MCP snapshots preserve environment, skip disabled peers and are disposable", async () => {
  await using tmp = await tmpdir()
  const policyFile = path.join(tmp.path, "policy.json")
  await Bun.write(policyFile, JSON.stringify({ mode: "workspace", allow_mcp: true }))
  const snapshot = prepareMcpConfig({
    binary: "unused",
    model: "unused",
    db: "unused",
    workspace: tmp.path,
    mcpSettings: local,
    policyFile,
  })
  if (!snapshot) throw new Error("authorized local config must produce a snapshot")
  try {
    expect(await Bun.file(snapshot.file).json()).toEqual([
      { name: "fixture", argv: ["node", "peer.js"], env: { FIXTURE_KEY: "fixture-value" } },
    ])
    expect(path.relative(tmp.path, snapshot.file).startsWith("..")).toBe(true)
    if (process.platform !== "win32") expect(statSync(snapshot.file).mode & 0o777).toBe(0o600)
  } finally {
    snapshot.dispose()
  }
  expect(existsSync(path.dirname(snapshot.file))).toBe(false)
})

test("unsupported shared MCP transport or identity settings are not silently discarded", async () => {
  await using tmp = await tmpdir()
  const policyFile = path.join(tmp.path, "policy.json")
  await Bun.write(policyFile, JSON.stringify({ mode: "workspace", allow_mcp: true }))
  for (const server of [
    { type: "remote", url: "https://example.invalid/mcp" },
    { type: "local", command: ["node", "peer.js"], call_meta: { Authorization: "fixture" } },
    { type: "local", command: ["node", "peer.js"], cwd: "nested" },
  ]) {
    const mcpSettings = Schema.decodeUnknownSync(ConfigMCP.Info)({ servers: { fixture: server } })
    expect(() =>
      prepareMcpConfig({
        binary: "unused",
        model: "unused",
        db: "unused",
        workspace: tmp.path,
        mcpSettings,
        policyFile,
      }),
    ).toThrow("Native MCP shared configuration")
  }
})
