import { describe, expect, test } from "bun:test"
import { clean } from "@miao/core/tool/bash-token-pipeline"

describe("bash token-efficiency pipeline", () => {
  test("folds carriage-return progress redraws to the last frame", () => {
    const raw = "downloading\rdownloading 40%\rdownloading 100%\ndone"
    expect(clean(raw)).toBe("downloading 100%\ndone")
  })

  test("strips ANSI styling, cursor moves, and control bytes", () => {
    const raw = "\x1b[1m\x1b[32mbuild ok\x1b[0m\x1b[2K\nnext\x7f\x08step\x07"
    const result = clean(raw)
    expect(result).toBe("build ok\nnextstep")
    expect(result).not.toContain("\x1b")
  })

  test("redacts secrets printed by a command", () => {
    const raw =
      "Bearer sk-proj-abcdef1234567890abcdef\nAKIAIOSFODNN7EXAMPLE\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"
    const result = clean(raw)
    expect(result).not.toContain("sk-proj-abcdef1234567890abcdef")
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(result).toContain("<redacted")
  })

  test("redacts secrets inside long collapsed lines (redact before collapse)", () => {
    const long = "export const config = '" + "x".repeat(600) + "' token=ghp_AAAABBBBCCCCDDDDEEEEFFFF"
    const result = clean(long)
    expect(result).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFF")
    expect(result).toContain("chars elided")
  })

  test("collapses long lines with a head keep and an elision marker", () => {
    const long = "y".repeat(600)
    const result = clean(long)
    expect(result.startsWith("y".repeat(160) + "<…")).toBe(true)
    expect(result).toContain("chars elided…>")
    expect(result.length).toBeLessThan(300)
  })

  test("never returns a longer or equal-length output (never-worse guard)", () => {
    const short = "ok"
    expect(clean(short)).toBe(short)
    const styled = "\x1b[1mok\x1b[0m"
    expect(clean(styled)).toBe("ok")
    expect(clean(styled).length).toBeLessThan(styled.length)
  })

  test("returns unchanged output untouched", () => {
    const plain = "regular output\nsecond line"
    expect(clean(plain)).toBe(plain)
  })

  test("a command containing # nofilter or # raw opts out", () => {
    const raw = "\x1b[1mstyled\x1b[0m\rprogress\x1b[2K"
    expect(clean(raw, { command: "make test # nofilter" })).toBe(raw)
    expect(clean(raw, { command: "cargo build # raw" })).toBe(raw)
  })

  test("the raw flag disables the pipeline globally", () => {
    const raw = "\x1b[1mstyled\x1b[0m"
    expect(clean(raw, { raw: true })).toBe(raw)
  })

  test("an ANSI-heavy progress output shrinks substantially", () => {
    const frames = Array.from({ length: 50 }, (_, i) => `\r\x1b[32m[bar] ${"█".repeat(i)} ${i}%\x1b[0m`).join("")
    const raw = frames + "\ncomplete\n" + "line\n".repeat(20)
    const result = clean(raw)
    expect(result.length).toBeLessThan(raw.length / 4)
    expect(result).toContain("complete")
    expect(result).toContain("line")
  })

  test("empty output stays empty", () => {
    expect(clean("")).toBe("")
  })
})
