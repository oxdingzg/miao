import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Option } from "effect"
import { Config } from "@miao/core/config"
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

for (const name of cases) {
  test(`golden case ${name} matches the shared expected policy`, async () => {
    const directory = path.join(root, name, "global")
    const entries: Config.Entry[] = []
    for (const file of Config.fileNames) {
      const file_ = path.join(directory, file)
      if (!fs.existsSync(file_)) continue
      const info = Option.getOrUndefined(Config.decodeDocument(Config.parseJsonc(await Bun.file(file_).text())))
      if (info) entries.push(new Config.Document({ type: "document", info }))
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
