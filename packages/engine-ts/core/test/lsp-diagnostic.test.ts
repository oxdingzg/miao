import { describe, expect, test } from "bun:test"
import { Language } from "@miao/core/lsp/language"
import { Diagnostic } from "@miao/core/lsp/diagnostic"

describe("LSP language map", () => {
  test("maps common extensions to language ids", () => {
    expect(Language.LANGUAGE_EXTENSIONS[".ts"]).toBe("typescript")
    expect(Language.LANGUAGE_EXTENSIONS[".go"]).toBe("go")
  })
})

describe("LSP diagnostic report", () => {
  const diagnostic = (severity: number, line: number, message: string): Diagnostic.Diagnostic => ({
    severity,
    range: { start: { line, character: 0 } },
    message,
  })

  test("renders only error diagnostics", () => {
    expect(Diagnostic.report("a.ts", [])).toBe("")
    expect(Diagnostic.report("a.ts", [diagnostic(2, 0, "warn only")])).toBe("")
    expect(Diagnostic.report("a.ts", [diagnostic(1, 4, "Type error"), diagnostic(2, 9, "unused")])).toBe(
      '<diagnostics file="a.ts">\nERROR [5:1] Type error\n</diagnostics>',
    )
    expect(Diagnostic.pretty(diagnostic(4, 0, "hint"))).toBe("HINT [1:1] hint")
  })

  test("caps the number of reported errors", () => {
    const many = Array.from({ length: 25 }, (_unused, index) => diagnostic(1, index, `e${index}`))
    expect(Diagnostic.report("a.ts", many)).toContain("... and 5 more")
  })
})
