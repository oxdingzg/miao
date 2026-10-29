import { expect, test } from "bun:test"
import path from "node:path"
import { chmod } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

for (const scenario of ["old-protocol", "old-routes", "compatible", "launcher"] as const)
  test.skipIf(process.platform === "win32")(
    `Rust TUI engine compatibility: ${scenario}`,
    async () => {
      await using tmp = await tmpdir()
      const binary = path.join(tmp.path, "miao-engine")
      const tui = path.join(tmp.path, "miao-tui")
      await Bun.write(
        binary,
        `#!/bin/sh
if [ "$1" = "--capabilities" ]; then
  printf '%s' '${JSON.stringify({ name: "miao-engine", version: "0.3.6", protocol: scenario === "old-protocol" || scenario === "launcher" ? 1 : 2, schema: 21, routes_schema: scenario === "old-routes" ? 1 : 2, saved_rules_snapshot: 1 })}'
  exit 0
fi
printf started > "$0.started"
printf fixture-raw
exit 23
`,
      )
      await chmod(binary, 0o755)
      await Bun.write(tui, '#!/bin/sh\nprintf started > "$0.started"\nexit 94\n')
      await chmod(tui, 0o755)
      const child = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          ...(scenario === "launcher" ? [tmp.path, "--tui", "rust"] : ["__engine-shim", "serve"]),
        ],
        {
          cwd: path.resolve(import.meta.dir, "../.."),
          env: {
            ...process.env,
            MIAO_ENGINE_BIN: binary,
            MIAO_ENGINE_REAL_BIN: binary,
            MIAO_TUI_BIN: tui,
            MIAO_ENGINE_STORAGE: path.join(tmp.path, "engines"),
            MIAO_DB: path.join(tmp.path, "product.db"),
            MIAO_PURE: "1",
            MIAO_TEST_HOME: path.join(tmp.path, "home"),
            XDG_CONFIG_HOME: path.join(tmp.path, "config"),
            XDG_DATA_HOME: path.join(tmp.path, "data"),
            XDG_STATE_HOME: path.join(tmp.path, "state"),
            XDG_CACHE_HOME: path.join(tmp.path, "cache"),
            MIAO_MODELS_JSON: path.resolve(import.meta.dir, "../../../core/test/plugin/fixtures/models.json"),
            MIAO_CONFIG_CONTENT: JSON.stringify({ formatter: false, lsp: false }),
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timer = setTimeout(() => child.kill(), 20_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (scenario === "compatible") {
          expect(code).toBe(23)
          expect(stdout).toBe("fixture-raw")
          expect(await Bun.file(`${binary}.started`).exists()).toBe(true)
          return
        }
        expect(code).toBe(1)
        expect(stdout).toBe("")
        expect(stderr).toContain("requires protocol 2 and route schema 2")
        expect(await Bun.file(`${binary}.started`).exists()).toBe(false)
        expect(await Bun.file(`${tui}.started`).exists()).toBe(false)
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    },
    30_000,
  )
