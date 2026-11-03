import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/** The repository root, four levels above this test file. */
const root = path.resolve(import.meta.dir, "../../../..")

function read(relative: string) {
  return readFileSync(path.join(root, relative), "utf8")
}

// One binary is the product (`docs/cli.md`), and two places decide which crate
// builds it. When they disagree a release ships a binary that answers
// `--version` but not the documented commands — v0.3.27 published the bare TUI
// that way, so the drift is caught at review time instead of after a release.
test("docs/cli.md names the crate the release pipeline builds", () => {
  const declared = /The product is the single Rust binary \(`crates\/([a-z0-9-]+)`/.exec(read("docs/cli.md"))
  expect(declared).not.toBeNull()

  const product = /const PRODUCT = \{ crate: "([a-z0-9-]+)", binary: "([a-z0-9-]+)" \} as const/.exec(
    read("packages/miao/script/build.ts"),
  )
  expect(product).not.toBeNull()
  expect(product![1]).toBe(declared![1]!)
  // The installer and the docs both call the product `miao`, so the name is fixed.
  expect(product![2]).toBe("miao")
})

test("the native artifact workflow packages the product crate", () => {
  const workflow = read(".github/workflows/engine-artifacts.yml")
  expect(workflow).toContain("working-directory: crates/miao-cli")
  expect(workflow).toContain("--bin miao\n")
  expect(workflow).toContain('release/miao${EXE}"')
  // A companion archive must never be copied in as the product binary again.
  expect(workflow).not.toContain("release/miao-tui")
})
