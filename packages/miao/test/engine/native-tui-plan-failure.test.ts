import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.MIAO_ENGINE_BIN

test.skipIf(!binary)(
  "the TUI shim never opens a bare engine after default-agent plan preparation fails",
  async () => {
    await using tmp = await tmpdir()
    const workspace = path.join(tmp.path, "workspace")
    await Bun.write(path.join(workspace, "fixture"), "fixture")
    const storage = path.join(tmp.path, "native.db")
    const child = Bun.spawn(
      [
        process.execPath,
        "src/index.ts",
        "__engine-shim",
        "serve",
        "--db",
        storage,
        "--workspace",
        workspace,
        "--model",
        "fixture/fixture",
        "--provider",
        "openai-chat",
        "--endpoint",
        "http://127.0.0.1:9",
      ],
      {
        cwd: path.join(import.meta.dir, "../.."),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          MIAO_ENGINE_BIN: binary,
          MIAO_ENGINE_REAL_BIN: binary,
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:9",
          OPENAI_API_KEY: "fixture-only",
          MIAO_SHARED_PERMISSIONS: "",
          MIAO_DB: path.join(tmp.path, "core.db"),
          MIAO_PURE: "1",
          MIAO_TEST_HOME: path.join(tmp.path, "home"),
          MIAO_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          MIAO_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            agents: { build: { model: "fixture/missing" } },
            formatter: false,
            lsp: false,
            providers: {
              fixture: {
                name: "Fixture",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: "http://127.0.0.1:9",
                  settings: { apiKey: "fixture-only" },
                },
                models: { fixture: { name: "Fixture" } },
              },
            },
          }),
        },
      },
    )
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    const deadline = setTimeout(() => child.kill(), 25_000)
    try {
      child.stdin.write(JSON.stringify({ id: 1, method: "sessions" }) + "\n")
      child.stdin.write(JSON.stringify({ id: 2, method: "shutdown" }) + "\n")
      await child.stdin.flush()
      const code = await child.exited
      expect(await errors).toContain("could not prepare the product engine plan")
      expect(code).toBe(1)
      expect(await output).toBe("")
      expect(await Bun.file(storage).exists()).toBe(false)
    } finally {
      clearTimeout(deadline)
      child.kill()
      await child.exited
    }
  },
  30_000,
)
