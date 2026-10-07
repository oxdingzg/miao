import { describe, expect, test } from "bun:test"
import { EditRecovery } from "@miao/core/tool/edit-recovery"

const file = (lines: string[]) => lines.join("\n")
const block = file([
  "export function publish(event: Event) {",
  "  const payload = encode(event)",
  "  bus.send(payload)",
  "  metrics.count(event.kind)",
  "}",
])

describe("EditRecovery.recover", () => {
  test("recovers when lines were inserted inside the quoted span", () => {
    const snapshot = file(["const a = 1", ...block.split("\n"), "const z = 9"])
    const current = file([
      "const a = 1",
      "// new header",
      "// new header 2",
      ...block.split("\n"),
      "const z = 9",
    ])
    const oldString = file(["const a = 1", ...block.split("\n")])
    const outcome = EditRecovery.recover({
      snapshot,
      current,
      oldString,
      newString: "export function publish(event: Event) {\n  bus.send(encode(event))\n}",
    })
    expect(outcome._tag).toBe("recovered")
    if (outcome._tag !== "recovered") return
    // The inserted lines sit inside the quoted span, so the rebase replaces the
    // whole span; the diff surfaces that drift as removed lines.
    expect(outcome.replaced).toBe("export function publish(event: Event) {\n  bus.send(encode(event))\n}\nconst z = 9")
    expect(outcome.replaced).not.toContain("// new header")
    expect(outcome.note).toContain("rebased")
  })

  test("recovers when the block was edited after the snapshot and lines were removed below", () => {
    const snapshot = file(["const a = 1", ...block.split("\n"), "const z = 9"])
    const current = file(["const a = 1", "export function publish(event: Event) {", "  bus.send(stale)", "}", "const z = 9"])
    const outcome = EditRecovery.recover({ snapshot, current, oldString: block, newString: "const fresh = true" })
    expect(outcome._tag).toBe("recovered")
    if (outcome._tag !== "recovered") return
    expect(outcome.replaced).toBe(file(["const a = 1", "const fresh = true", "const z = 9"]))
  })

  test("recovers with a single anchor at a file boundary", () => {
    const snapshot = file([...block.split("\n"), "const tail = 1"])
    const current = file(["export function publish(event: Event) {", "  bus.send(stale)", "}", "const tail = 1"])
    const outcome = EditRecovery.recover({ snapshot, current, oldString: block, newString: "const fresh = true" })
    expect(outcome._tag).toBe("recovered")
    if (outcome._tag !== "recovered") return
    expect(outcome.replaced).toBe(file(["const fresh = true", "const tail = 1"]))
  })

  test("refuses an ambiguous snapshot occurrence", () => {
    const twice = file([...block.split("\n"), "const z = 9", ...block.split("\n")])
    const outcome = EditRecovery.recover({ snapshot: twice, current: file(["const a = 1"]), oldString: block, newString: "x" })
    expect(outcome).toEqual({ _tag: "refused", reason: "ambiguous" })
  })

  test("refuses when no unique context anchor survives", () => {
    const snapshot = file(["unique-top", ...block.split("\n"), "unique-bottom"])
    const current = file(["const a = 1", "const b = 2", "const c = 3"])
    const outcome = EditRecovery.recover({ snapshot, current, oldString: block, newString: "x" })
    expect(outcome).toEqual({ _tag: "refused", reason: "unanchored" })
  })

  test("refuses a disproportionate drifted region", () => {
    const snapshot = file(["const a = 1", ...block.split("\n"), "const z = 9"])
    const current = file([
      "const a = 1",
      ...Array.from({ length: 20 }, (_, index) => `// drifted ${index}`),
      "const z = 9",
    ])
    const outcome = EditRecovery.recover({ snapshot, current, oldString: block, newString: "x" })
    expect(outcome).toEqual({ _tag: "refused", reason: "disproportionate" })
  })

  test("inapplicable when oldString is present in current or absent from snapshot", () => {
    const snapshot = file(["const a = 1", "const b = 2"])
    expect(
      EditRecovery.recover({ snapshot, current: file(["const a = 1", "const b = 2"]), oldString: "const b = 2", newString: "x" }),
    ).toEqual({ _tag: "inapplicable" })
    expect(
      EditRecovery.recover({ snapshot, current: file(["const c = 3"]), oldString: "const zzz = 0", newString: "x" }),
    ).toEqual({ _tag: "inapplicable" })
  })
})
