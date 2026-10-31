import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Option } from "effect"
import { Config } from "@miao/core/config"
import { ConfigDiagnostics } from "@miao/core/config/diagnostics"
import { ConfigExplain } from "@miao/core/config/explain"
import { LSPServer } from "@miao/core/lsp/server"
import { SandboxPolicy } from "@miao/core/sandbox/policy"

/**
 * Golden alignment for S5 step 2: the engine derives the product policy from
 * these same directories (`crates/miao-engine/tests/fixtures/config-golden`)
 * with its own parser, so both implementations must read one set of samples
 * into the same normalized result. The TypeScript side of that contract is the
 * document precedence plus the sandbox switch the policy records.
 */
const root = path.join(import.meta.dir, "../../../../crates/miao-engine/tests/fixtures/config-golden")

const cases = fs
  .readdirSync(root)
  .filter((name) => fs.existsSync(path.join(root, name, "expected-policy.json")))
  .sort()

test("the golden cases are present", () => {
  expect(cases.length).toBeGreaterThanOrEqual(5)
})

const lspCases = fs
  .readdirSync(root)
  .filter((name) => fs.existsSync(path.join(root, name, "expected-lsp.json")))
  .sort()

// The engine derives LSP servers from the config plan once the product stops
// materializing a manifest; the TypeScript reference derivation must produce
// the same entries from the same cases.
for (const name of lspCases) {
  test(`golden case ${name} matches the shared expected lsp config`, async () => {
    const directory = path.join(root, name, "global")
    const environment = JSON.parse(fs.readFileSync(path.join(root, name, "env.json"), "utf8")) as {
      installed?: string[]
    }
    const installed = new Set(environment.installed ?? [])
    type Server = {
      id: string
      command: readonly string[]
      extensions: readonly string[]
      env?: Record<string, string>
      initialization?: Record<string, unknown>
    }
    const servers = new Map<string, Server>(
      LSPServer.servers.map((server) => [server.id, { ...server, env: server.environment }]),
    )
    const configured = (
      await Promise.all(
        Config.fileNames.map(async (file) => {
          const file_ = path.join(directory, file)
          if (!fs.existsSync(file_)) return undefined
          const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file_).text())))
          return info?.lsp
        }),
      )
    )
      .filter((lsp) => lsp !== undefined)
      .at(-1)
    if (configured === false) {
      servers.clear()
    } else if (configured !== true && configured !== undefined) {
      for (const [id, override] of Object.entries(configured)) {
        if (override.disabled === true) {
          servers.delete(id)
          continue
        }
        if (!("command" in override)) continue
        servers.set(id, {
          id,
          command: override.command,
          extensions: override.extensions ?? servers.get(id)?.extensions ?? [],
          env: override.env ?? servers.get(id)?.env,
          initialization: override.initialization ?? servers.get(id)?.initialization,
        })
      }
    }
    const resolve = (command: string) =>
      command.startsWith("/") ? command : installed.has(command) ? `/tools/${command}` : undefined
    const entries = Array.from(servers.values()).flatMap((server) => {
      const argv0 = resolve(server.command[0])
      if (argv0 === undefined) return []
      return [
        {
          name: server.id,
          argv: [argv0, ...server.command.slice(1)],
          extensions: server.extensions,
          env: server.env ?? {},
          initialization: server.initialization ?? null,
        },
      ]
    })
    const expected = JSON.parse(fs.readFileSync(path.join(root, name, "expected-lsp.json"), "utf8"))
    expect(entries).toEqual(expected)
  })
}

for (const name of cases) {
  test(`golden case ${name} matches the shared expected policy`, async () => {
    const directory = path.join(root, name, "global")
    const entries: Config.Entry[] = []
    // A sources.json plan drives the same ordered multi-source read the host
    // forwards as --config-sources; a plain case keeps the single global dir.
    const sourcesFile = path.join(root, name, "sources.json")
    if (fs.existsSync(sourcesFile)) {
      const sources = JSON.parse(fs.readFileSync(sourcesFile, "utf8")) as Array<{ dir?: string; file?: string }>
      for (const source of sources) {
        const paths = source.dir
          ? Config.fileNames.map((file) => path.join(root, name, source.dir!, file))
          : [path.join(root, name, source.file!)]
        for (const file of paths) {
          if (!fs.existsSync(file)) continue
          const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file).text())))
          if (info) entries.push(new Config.Document({ type: "document", info }))
        }
      }
    } else {
      for (const file of Config.fileNames) {
        const file_ = path.join(directory, file)
        if (!fs.existsSync(file_)) continue
        const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file_).text())))
        if (info) entries.push(new Config.Document({ type: "document", info }))
      }
    }
    const merged = Option.getOrUndefined(Config.decodeDocument(Config.merge(entries)))
    const environment: Record<string, string | undefined> = {}
    const raw = JSON.parse(fs.readFileSync(path.join(root, name, "env.json"), "utf8")) as {
      MIAO_SANDBOX?: string | null
    }
    if (raw.MIAO_SANDBOX !== null && raw.MIAO_SANDBOX !== undefined) environment.MIAO_SANDBOX = raw.MIAO_SANDBOX
    const sandbox = SandboxPolicy.nativeEnabled(merged?.sandbox ? [merged.sandbox] : [], environment)
    const expected = JSON.parse(fs.readFileSync(path.join(root, name, "expected-policy.json"), "utf8")) as {
      sandbox: boolean
    }
    expect(sandbox).toBe(expected.sandbox)
  })
}

// The engine reports which document won each effective value, so the product
// can show where a setting came from. Both readers must name the same file for
// the same leaf, or a user sees one answer in the TUI and another in the
// engine's errors; the shared case pins that.
const explainCases = fs
  .readdirSync(root)
  .filter((name) => fs.existsSync(path.join(root, name, "expected-explain.json")))
  .sort()

for (const name of explainCases) {
  test(`golden case ${name} matches the shared expected provenance`, async () => {
    const caseDirectory = path.join(root, name)
    const plan = JSON.parse(fs.readFileSync(path.join(caseDirectory, "sources.json"), "utf8")) as Array<{
      dir?: string
      file?: string
    }>
    const scoped: ConfigExplain.ScopedEntry[] = []
    for (const source of plan) {
      const scope: ConfigExplain.Scope =
        source.dir === "global" ? "global" : source.dir === "local" ? "local" : "project"
      const files = source.dir
        ? Config.fileNames.map((file) => path.join(caseDirectory, source.dir!, file))
        : [path.join(caseDirectory, source.file!)]
      for (const file of files) {
        if (!fs.existsSync(file)) continue
        const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file).text())))
        if (info) scoped.push({ entry: new Config.Document({ type: "document", path: file, info }), scope })
      }
    }
    const explanation = ConfigExplain.explain(scoped)
    // The engine sorts object keys while this reader preserves document order,
    // so both sides sort by path; origins are absolute here and relative in the
    // shared sample.
    const relative = (origin: string | undefined) => origin!.slice(caseDirectory.length + 1)
    const derived = {
      sources: explanation.sources.map((source) => ({
        origin: relative(source.origin.path),
        keys: [...source.keys].map((key) => JSON.stringify(key)).sort(),
      })),
      keys: [...explanation.keys]
        .map((key) => ({
          path: [...key.path],
          value: key.value,
          origin: relative(key.origin.path),
          overridden: key.overridden.map((leaf) => ({
            value: leaf.value,
            origin: relative(leaf.origin.path),
          })),
        }))
        .sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path))),
    }
    for (const source of derived.sources) source.keys = source.keys.map((key) => JSON.parse(key))
    const expected = JSON.parse(fs.readFileSync(path.join(caseDirectory, "expected-explain.json"), "utf8"))
    expect(derived).toEqual(expected)
  })
}

/**
 * The engine refuses a document whose root is not an object, naming the file
 * and the key path. The TypeScript diagnostics must refuse the same document,
 * at the same key path, instead of accepting it in silence: one shared sample,
 * two implementations, one verdict.
 */
test("an invalid config root is refused with its key path", () => {
  const fixture = path.join(root, "config-invalid-root")
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, "expected-error.json"), "utf8"))
  const document = JSON.parse(fs.readFileSync(path.join(fixture, expected.origin), "utf8"))
  const diagnostics = ConfigDiagnostics.of(document)
  expect(diagnostics.length).toBeGreaterThan(0)
  expect(diagnostics[0]!.kind).toBe("invalid-value")
  expect(diagnostics[0]!.path).toEqual(expected.keyPath === "" ? [] : expected.keyPath.split("."))
  expect(diagnostics[0]!.message).toContain("object")
})
