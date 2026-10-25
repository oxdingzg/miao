import { expect, test } from "bun:test"
import { nativeEngineOptions } from "@/engine/native-engine"
import { engineArgs } from "@/engine/client"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

test("explicit formatter manifest survives native option resolution and reaches argv", () => {
  const options = nativeEngineOptions({
    MIAO_ENGINE_BIN: "/tmp/engine",
    MIAO_ENGINE_FORMATTER_CONFIG: "formatter.json",
  })
  if (!options) throw new Error("native options missing")
  const args = engineArgs({ ...options, db: "/tmp/engine.db", workspace: "/workspace" })
  expect(args).toContain("--formatter-config")
  expect(args[args.indexOf("--formatter-config") + 1]).toBe(path.resolve("formatter.json"))
})

test("native coding receives only explicitly configured policy and endpoint", () => {
  expect(nativeEngineOptions({ MIAO_ENGINE_POLICY: "/tmp/policy.json" })).toBeUndefined()
  const baseline = nativeEngineOptions({ MIAO_ENGINE_BIN: "/tmp/engine", MIAO_ENGINE_MODEL: "fixture" })
  expect(baseline?.policyFile).toBeUndefined()
  expect(baseline?.endpoint).toBeUndefined()
  const configured = nativeEngineOptions({
    MIAO_ENGINE_BIN: "/tmp/engine",
    MIAO_ENGINE_MODEL: "fixture",
    MIAO_ENGINE_PROVIDER: "openai-chat",
    MIAO_ENGINE_POLICY: "/tmp/policy.json",
    MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:1234/chat/completions",
    MIAO_ENGINE_MODEL_ROUTES_CONFIG: "/host/model-routes.json",
  })
  if (!configured) throw new Error("native options missing")
  const args = engineArgs({ ...configured, db: "/tmp/engine.db", workspace: "/workspace" })
  expect(args[args.indexOf("--model-routes-config") + 1]).toBe("/host/model-routes.json")
  expect(args[args.indexOf("--policy") + 1]).toBe("/tmp/policy.json")
  expect(args[args.indexOf("--endpoint") + 1]).toBe("http://127.0.0.1:1234/chat/completions")
})

test.skipIf(process.platform === "win32")(
  "native activation rejects incompatible binaries before serving",
  async () => {
    await using tmp = await tmpdir()
    const binary = path.join(tmp.path, "miao-engine")
    await Bun.write(
      binary,
      `#!/bin/sh
if [ "$1" = "--capabilities" ]; then
  printf '%s' '{"name":"miao-engine","version":"0.3.6","protocol":2,"schema":21,"routes_schema":1}'
  exit 0
fi
printf engine-started >"$0.started"
exit 94
`,
    )
    await chmod(binary, 0o755)
    const child = Bun.spawn(
      [process.execPath, "src/index.ts", "run", "--engine", "native", "--dir", tmp.path, "QA only"],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          MIAO_ENGINE_BIN: binary,
          MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
          MIAO_DB: path.join(tmp.path, "product.db"),
          MIAO_ENGINE_MODEL: "fixture/fixture",
          MIAO_ENGINE_PROVIDER: "openai-chat",
          MIAO_ENGINE_ENDPOINT: "http://127.0.0.1:1/v1/chat/completions",
          MIAO_PURE: "1",
          MIAO_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            formatter: false,
            lsp: false,
            providers: {
              fixture: {
                name: "Fixture",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: "http://127.0.0.1:1",
                  settings: { apiKey: "fixture-only" },
                },
                models: { fixture: { name: "Fixture" } },
              },
            },
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).not.toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain("requires protocol 2 and route schema 2")
      expect(await Bun.file(`${binary}.started`).exists()).toBe(false)
    } finally {
      clearTimeout(timer)
    }
  },
  30_000,
)
