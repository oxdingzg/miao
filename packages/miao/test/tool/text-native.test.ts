import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { createRequire } from "module"
import path from "path"
import { encode as encodeO200k } from "gpt-tokenizer/encoding/o200k_base"
import { encode as encodeCl100k } from "gpt-tokenizer/encoding/cl100k_base"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  detectLineEnding(text: string): string
  normalizeLineEndings(text: string, eol: string): string
  countTokens(text: string, encoding?: string): number
  sha256Hex(text: string): string
  blake3Hex(text: string): string
}

const native: Native | undefined = (() => {
  try {
    return require(nativePath) as Native
  } catch {
    return undefined
  }
})()

// CI builds the Rust crate and sets this so the suite cannot silently skip.
if (process.env.MIAO_NATIVE_REQUIRED === "1" && native === undefined) {
  throw new Error(`MIAO_NATIVE_REQUIRED=1 but ${nativePath} is missing; build crates/miao-native first`)
}

// Reference behavior the native path must match.
const detect = (text: string) => {
  const match = text.match(/\r\n|\r|\n/)
  if (!match) return "none"
  return match[0] === "\r\n" ? "crlf" : match[0] === "\n" ? "lf" : "cr"
}
const normalize = (text: string, eol: string) => {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  return eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf
}

const cases = ["a\r\nb", "a\nb", "a\rb", "abc", "", "\n", "\r\n", "x\r\ny\rz\n", "mixed\r\n\r\n", "\r\nfirst\r\n"]

const withNative = native ? describe : describe.skip

withNative("native text parity", () => {
  test("detectLineEnding matches the reference", () => {
    for (const text of cases) expect(native!.detectLineEnding(text)).toBe(detect(text))
  })

  test("normalizeLineEndings matches the reference", () => {
    for (const text of cases)
      for (const eol of ["lf", "crlf"]) expect(native!.normalizeLineEndings(text, eol)).toBe(normalize(text, eol))
  })

  test("countTokens matches gpt-tokenizer", () => {
    const samples = [
      "hello world",
      "clean 智能 六院",
      "function foo() { return 1 }\nconst x = 2",
      "a".repeat(200),
      "line1\nline2\tend",
      "def main():\n    print('hi')",
    ]
    for (const text of samples) {
      expect(native!.countTokens(text)).toBe(encodeO200k(text).length)
      expect(native!.countTokens(text, "cl100k_base")).toBe(encodeCl100k(text).length)
    }
  })

  test("sha256Hex matches Node's crypto", () => {
    for (const text of ["", "hello", "clean 智能 六院", "a".repeat(1000)]) {
      expect(native!.sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"))
    }
  })

  test("blake3Hex matches the known empty vector", () => {
    expect(native!.blake3Hex("")).toBe("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262")
  })
})
