import { describe, expect, test } from "bun:test"
import { native } from "@miao/native"
import { Patch } from "@miao/core/patch"

/**
 * Parity between the TypeScript `Patch.deriveTs` reference and the Rust
 * `deriveNewContentsV2` primitive that the V2 core patch path uses. The addon is
 * absent in a plain checkout, so the suite skips; CI builds it and sets
 * `MIAO_NATIVE_REQUIRED=1` to fail instead of silently skipping.
 */
const activeNative = typeof native?.deriveNewContentsV2 === "function" ? native : undefined

if (process.env.MIAO_NATIVE_REQUIRED === "1" && activeNative === undefined) {
  throw new Error("MIAO_NATIVE_REQUIRED=1 but the @miao/native addon does not expose deriveNewContentsV2")
}

type Case = { path: string; chunks: ReadonlyArray<Patch.UpdateFileChunk>; original: string }

const toNativeChunks = (chunks: ReadonlyArray<Patch.UpdateFileChunk>) =>
  chunks.map((chunk) => ({
    oldLines: [...chunk.oldLines],
    newLines: [...chunk.newLines],
    changeContext: chunk.changeContext,
    isEndOfFile: chunk.endOfFile,
  }))

const cases: Case[] = [
  { path: "f.txt", original: "line1\nline2\nline3\n", chunks: [{ oldLines: ["line2"], newLines: ["CHANGED"] }] },
  { path: "f.txt", original: "line1\nline2\n", chunks: [{ oldLines: [], newLines: ["inserted"] }] },
  { path: "f.txt", original: "line1\n\n", chunks: [{ oldLines: [], newLines: ["inserted"] }] },
  { path: "f.txt", original: "line1\n\n", chunks: [{ oldLines: ["line1"], newLines: ["CHANGED"] }] },
  { path: "f.txt", original: "line1\n\n\n", chunks: [{ oldLines: ["line1"], newLines: ["CHANGED"] }] },
  { path: "f.txt", original: "", chunks: [{ oldLines: [], newLines: ["first"] }] },
  { path: "f.txt", original: "\uFEFFold\n", chunks: [{ oldLines: ["  old   "], newLines: ["new"] }] },
  {
    path: "f.txt",
    original: "marker\nmiddle\nmarker\nend\n",
    chunks: [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
  },
  {
    path: "f.txt",
    original: "header\nbody\nfooter\n",
    chunks: [{ oldLines: ["body"], newLines: ["BODY"], changeContext: "header" }],
  },
  {
    path: "f.txt",
    original: "const x = \"a\"\n",
    chunks: [{ oldLines: ["const x = \u201ca\u201d"], newLines: ["const x = 1"] }],
  },
  { path: "f.txt", original: "a\r\nb\r\nc\r\n", chunks: [{ oldLines: ["b"], newLines: ["B"] }] },
  { path: "f.txt", original: "no newline", chunks: [{ oldLines: ["no newline"], newLines: ["has newline"] }] },
  { path: "f.txt", original: "a\n\n\n", chunks: [{ oldLines: [], newLines: ["tail"] }] },
  { path: "f.txt", original: "a\nb\n", chunks: [{ oldLines: ["a", "b"], newLines: [] }] },
  { path: "f.txt", original: "a\nb\n", chunks: [{ oldLines: ["a", "b", ""], newLines: ["A", "B", ""] }] },
]

const outcome = <T>(run: () => T) => {
  try {
    return { ok: true as const, value: run() }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

const withNative = activeNative ? describe : describe.skip

withNative("native patch derive parity", () => {
  test("deriveTs and the addon agree on the fixture set", () => {
    for (const item of cases) {
      const expected = outcome(() => Patch.deriveTs(item.path, item.chunks, item.original))
      const actual = outcome(() => {
        const result = activeNative!.deriveNewContentsV2(toNativeChunks(item.chunks), item.path, item.original)
        return { content: result.content, bom: result.bom }
      })
      expect(actual).toEqual(expected)
    }
  })

  test("the wired backend selects the native primitive and stays equal", () => {
    expect(Patch.nativeDeriveActive()).toBe(true)
    for (const item of cases) {
      expect(Patch.derive(item.path, item.chunks, item.original)).toEqual(
        Patch.deriveTs(item.path, item.chunks, item.original),
      )
    }
  })

  test("deriveTs and the addon agree across a generated corpus", () => {
    const random = mulberry32(0xbeef)
    const tokens = ["alpha", "beta", "gamma", "delta", "epsilon"]
    let mismatches = 0

    for (let iteration = 0; iteration < 800; iteration++) {
      const lineCount = 1 + Math.floor(random() * 18)
      const lines = Array.from({ length: lineCount }, (_, index) => {
        const indent = " ".repeat(Math.floor(random() * 3))
        return `${indent}${tokens[Math.floor(random() * tokens.length)]} ${index}`
      })
      const trailing = random() < 0.15 ? "\n\n" : random() < 0.5 ? "\n" : ""
      const original = lines.join("\n") + trailing

      const mode = Math.floor(random() * 6)
      const start = Math.floor(random() * lineCount)
      const length = 1 + Math.floor(random() * Math.min(4, lineCount - start))
      const block = lines.slice(start, start + length)
      const chunks: Patch.UpdateFileChunk[] =
        mode === 0
          ? [{ oldLines: block, newLines: [`REPLACED_${iteration}`] }]
          : mode === 1
            ? [{ oldLines: [], newLines: [`INSERTED_${iteration}`] }]
            : mode === 2
              ? [{ oldLines: block.map((line) => line.trim()), newLines: [`TRIMMED_${iteration}`] }]
              : mode === 3
                ? [{ oldLines: [block[0], "   missing"], newLines: ["x"] }]
                : mode === 4
                  ? [{ oldLines: block, newLines: [`${block[0]} changed`, ...block.slice(1)] }]
                  : [{ oldLines: block, newLines: [`${block[0]}\u2019s`, ...block.slice(1)] }]

      const expected = outcome(() => Patch.deriveTs("f.txt", chunks, original))
      const actual = outcome(() => {
        const result = activeNative!.deriveNewContentsV2(toNativeChunks(chunks), "f.txt", original)
        return { content: result.content, bom: result.bom }
      })
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches++
        if (mismatches <= 5) console.error({ iteration, mode, original, chunks, expected, actual })
      }
    }

    expect(mismatches).toBe(0)
  })
})

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
