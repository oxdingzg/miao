import { describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { createRequire } from "module"
import os from "os"
import path from "path"
import { createTwoFilesPatch, diffLines } from "diff"
import { nativeEditActive, replace, replaceTs } from "../../src/tool/edit"
import { deriveNewContentsFromChunks, deriveNewContentsFromChunksTs, type UpdateFileChunk } from "../../src/patch"
import { resolveSandboxRunner, runSandboxed, sandboxAvailable } from "../../src/tool/sandbox"
import { sandboxRun } from "../../src/tool/sandbox-runner"
import { native as addonNative } from "@miao/native"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  applyEdit(
    content: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): { content: string; additions: number; deletions: number }
  diffStats(before: string, after: string): { additions: number; deletions: number }
  unifiedPatch(before: string, after: string, filePath: string): string
  deriveNewContents(
    chunks: Array<{ oldLines: string[]; newLines: string[]; changeContext?: string; isEndOfFile?: boolean }>,
    filePath: string,
    originalText: string,
  ): { content: string; unifiedDiff: string; bom: boolean }
  gitStatus(path: string): Array<{ path: string; status: string }>
  gitStatusAsync(path: string): Promise<Array<{ path: string; status: string }>>
}

function toNativeChunks(chunks: UpdateFileChunk[]) {
  return chunks.map((chunk) => ({
    oldLines: chunk.old_lines,
    newLines: chunk.new_lines,
    changeContext: chunk.change_context,
    isEndOfFile: chunk.is_end_of_file,
  }))
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

type Case = { name: string; content: string; oldString: string; newString: string; replaceAll?: boolean }

function outcome<T>(run: () => T) {
  try {
    return { ok: true as const, value: run() }
  } catch (error) {
    return { ok: false as const, message: (error as Error).message }
  }
}

const withNative = native ? describe : describe.skip

withNative("native edit parity", () => {
  const cases: Case[] = [
    { name: "exact", content: "old content here", oldString: "old content", newString: "new content" },
    { name: "replaceAll", content: "foo bar foo baz foo", oldString: "foo", newString: "qux", replaceAll: true },
    { name: "multiline", content: "line1\nline2\nline3", oldString: "line2", newString: "new line 2\nextra line" },
    { name: "crlf", content: "line1\r\nold\r\nline3", oldString: "old", newString: "new" },
    {
      name: "bom",
      content: "\uFEFFusing System;\nclass Test {}\n",
      oldString: "using System;",
      newString: "using Up;",
    },
    {
      name: "line-trimmed indentation",
      content: "function configure() {\n    const enabled = true\n}\n",
      oldString: "function configure() {\n  const enabled = true\n}",
      newString: "let result = 1",
    },
    {
      name: "whitespace-normalized",
      content: "const value = compute(  alpha,   beta )\nnext line\n",
      oldString: "const value = compute(alpha, beta)",
      newString: "const value = 0",
    },
    {
      name: "trimmed boundary",
      content: "  padded block  \ntail\n",
      oldString: "padded block",
      newString: "flush",
    },
    {
      name: "escape normalized",
      content: 'const message = "line\\nbreak"\n',
      oldString: 'const message = "line\nbreak"',
      newString: "const message = ok",
    },
    {
      name: "block anchor fuzzy single candidate",
      content: ["start", "  alpha beta gamma", "end"].join("\n"),
      oldString: ["start", "  alpha beta delta", "end"].join("\n"),
      newString: "matched",
    },
    {
      name: "block anchor rejection unrelated middle",
      content: ["function configure() {", "  removeAllUserData()", "}"].join("\n"),
      oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
      newString: "x",
    },
    { name: "not found", content: "actual content", oldString: "not in file", newString: "replacement" },
    { name: "identical", content: "content", oldString: "same", newString: "same" },
    { name: "empty old", content: "content", oldString: "", newString: "x" },
    { name: "multiple without replaceAll", content: "a foo b foo c", oldString: "foo", newString: "bar" },
  ]

  for (const testCase of cases) {
    test(`matches TS replace: ${testCase.name}`, () => {
      const expected = outcome(() => replaceTs(testCase.content, testCase.oldString, testCase.newString, testCase.replaceAll ?? false))
      const actual = outcome(() => native!.applyEdit(testCase.content, testCase.oldString, testCase.newString, testCase.replaceAll ?? false).content)
      expect(actual).toEqual(expected)
    })
  }

  test("matches TS replace across generated corpus", () => {
    const random = mulberry32(0x5eed)
    const tokens = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    let mismatches = 0

    for (let iteration = 0; iteration < 400; iteration++) {
      const lineCount = 3 + Math.floor(random() * 20)
      const lines = Array.from({ length: lineCount }, (_, i) => {
        const indent = " ".repeat(Math.floor(random() * 4))
        return `${indent}${tokens[Math.floor(random() * tokens.length)]} ${i} ${tokens[Math.floor(random() * tokens.length)]}`
      })
      const content = lines.join("\n")
      const start = Math.floor(random() * (lineCount - 2))
      const length = 1 + Math.floor(random() * Math.min(4, lineCount - start))
      const block = lines.slice(start, start + length)

      const mode = Math.floor(random() * 5)
      const oldString =
        mode === 0
          ? block.join("\n")
          : mode === 1
            ? block.map((line) => line.trim()).join("\n")
            : mode === 2
              ? block.map((line) => line.replace(/\s+/g, " ").trim()).join("\n")
              : mode === 3
                ? block.map((line, i) => (i === 0 ? "  " + line.trim() : line)).join("\n")
                : block.map((line, i) => (i === 1 ? line + " extra" : line)).join("\n")

      const newString = `REPLACED_${iteration}`
      const replaceAll = random() < 0.25

      const expected = outcome(() => replaceTs(content, oldString, newString, replaceAll))
      const actual = outcome(() => native!.applyEdit(content, oldString, newString, replaceAll).content)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches++
        if (mismatches <= 5) console.error({ iteration, mode, oldString, newString, expected, actual })
      }
    }

    expect(mismatches).toBe(0)
  })

  test("diff stats match jsdiff diffLines", () => {
    const pairs: Array<[string, string]> = [
      ["line1\nline2\nline3", "line1\nnew a\nnew b\nline3"],
      ["a\nb\nc\nd", "a\nc\nd"],
      ["", "brand new\nfile"],
      ["remove everything\n", ""],
      [Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), Array.from({ length: 200 }, (_, i) => `line ${i * 2}`).join("\n")],
    ]
    for (const [before, after] of pairs) {
      const stats = diffLines(before, after).reduce(
        (acc, change) => ({
          additions: acc.additions + (change.added ? (change.count ?? 0) : 0),
          deletions: acc.deletions + (change.removed ? (change.count ?? 0) : 0),
        }),
        { additions: 0, deletions: 0 },
      )
      expect(native!.diffStats(before, after)).toEqual(stats)
    }
  })

  test("unified patch matches jsdiff createTwoFilesPatch", () => {
    const pairs: Array<[string, string]> = [
      ["l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10", "l1\nl2\nl3\nl4\nCHANGED\nl6\nl7\nl8\nl9\nl10"],
      ["a\nb\nc", "a\nB\nc"],
      [
        Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
        Array.from({ length: 30 }, (_, i) => (i === 15 ? "CHANGED" : `line ${i}`)).join("\n"),
      ],
    ]
    for (const [before, after] of pairs) {
      expect(native!.unifiedPatch(before, after, "f.txt")).toBe(createTwoFilesPatch("f.txt", "f.txt", before, after))
    }
  })
})

withNative("native patch parity", () => {
  type PatchCase = { name: string; content: string; chunks: UpdateFileChunk[] }

  const cases: PatchCase[] = [
    { name: "exact replace", content: "a\nb\nc\nd\n", chunks: [{ old_lines: ["b"], new_lines: ["B"] }] },
    { name: "insert lines", content: "a\nb\n", chunks: [{ old_lines: [], new_lines: ["x", "y"] }] },
    {
      name: "trim match",
      content: "a\n  b  \nc\n",
      chunks: [{ old_lines: ["b"], new_lines: ["B"] }],
    },
    {
      name: "unicode normalize",
      content: 'const x = "a"\n',
      chunks: [{ old_lines: ["const x = \u201ca\u201d"], new_lines: ["const x = 1"] }],
    },
    {
      name: "end of file anchor",
      content: "a\nb\nc\nd\n",
      chunks: [{ old_lines: ["c", "d"], new_lines: ["C", "D"], is_end_of_file: true }],
    },
    {
      name: "context seek",
      content: "header\nbody\nfooter\n",
      chunks: [{ old_lines: ["body"], new_lines: ["BODY"], change_context: "header" }],
    },
    { name: "bom preserved", content: "\uFEFFa\nb\n", chunks: [{ old_lines: ["b"], new_lines: ["B"] }] },
    {
      name: "missing lines",
      content: "a\nb\n",
      chunks: [{ old_lines: ["missing"], new_lines: ["x"] }],
    },
  ]

  for (const testCase of cases) {
    test(`matches TS deriveNewContentsFromChunks: ${testCase.name}`, () => {
      const expected = outcome(() => {
        const result = deriveNewContentsFromChunksTs("f.txt", testCase.chunks, testCase.content)
        return { content: result.content, unifiedDiff: result.unified_diff, bom: result.bom }
      })
      const actual = outcome(() => native!.deriveNewContents(toNativeChunks(testCase.chunks), "f.txt", testCase.content))
      expect(actual).toEqual(expected)
    })
  }
})

withNative("native git parity", () => {
  function git(cwd: string, args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  }

  test("matches git status for a temp repo", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-native-git-"))
    try {
      git(dir, ["init", "-q"])
      writeFileSync(path.join(dir, "a.txt"), "a\n")
      writeFileSync(path.join(dir, "keep.txt"), "k\n")
      git(dir, ["add", "-A"])
      git(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"])
      writeFileSync(path.join(dir, "a.txt"), "a changed\n")
      writeFileSync(path.join(dir, "b.txt"), "b\n")

      const nativeEntries = native!.gitStatus(dir).map((entry) => `${entry.status} ${entry.path}`).sort()
      const porcelain = git(dir, ["status", "--porcelain", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const code = entry.slice(0, 2)
          const file = entry.slice(3)
          const status =
            code.trim() === "??"
              ? "added"
              : code.includes("D")
                ? "deleted"
                : "modified"
          return `${status} ${file}`
        })
        .sort()
      expect(nativeEntries).toEqual(porcelain)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("gitStatusAsync matches gitStatus", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-native-git-async-"))
    try {
      git(dir, ["init", "-q"])
      for (let i = 0; i < 50; i++) writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`)
      git(dir, ["add", "-A"])
      git(dir, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"])
      for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `f${i}.txt`), "changed\n")
      writeFileSync(path.join(dir, "new.txt"), "new\n")

      const sync = native!.gitStatus(dir).map((entry) => `${entry.status} ${entry.path}`).sort()
      const async = (await native!.gitStatusAsync(dir)).map((entry) => `${entry.status} ${entry.path}`).sort()
      expect(async).toEqual(sync)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const miaoRunPath = path.join(import.meta.dir, "../../../../crates/miao-native/target/release/miao-run")
if (process.env.MIAO_NATIVE_REQUIRED === "1" && (process.platform !== "darwin" || !existsSync(miaoRunPath))) {
  throw new Error(`MIAO_NATIVE_REQUIRED=1 but ${miaoRunPath} is missing; build crates/miao-native first`)
}
const withMiaoRun = process.platform === "darwin" && existsSync(miaoRunPath) ? describe : describe.skip

withMiaoRun("native sandbox (miao-run)", () => {
  test("allows writes inside the workdir and denies writes outside", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-sbx-"))
    try {
      const inside = spawnSync(miaoRunPath, ["--workdir", dir, "--", "sh", "-c", `echo ok > "${dir}/ok.txt"`])
      expect(inside.status).toBe(0)
      expect(existsSync(path.join(dir, "ok.txt"))).toBe(true)

      const escape = path.join(dir, "..", `escape-${process.pid}.txt`)
      const outside = spawnSync(miaoRunPath, ["--workdir", dir, "--", "sh", "-c", `echo x > "${escape}"`])
      expect(outside.status).not.toBe(0)
      expect(existsSync(escape)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("escalates denied paths and retries", async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), "miao-sbx-wd-"))
    const cache = mkdtempSync(path.join(os.tmpdir(), "miao-sbx-cache-"))
    try {
      const approvals: string[][] = []
      const result = await runSandboxed({
        runner: { program: miaoRunPath, prefix: [] },
        command: ["sh", "-c", `echo x > "${path.join(cache, "f.txt")}"`],
        workdirs: [workdir],
        ask: async (denied) => {
          approvals.push(denied)
          return [cache]
        },
      })
      expect(result.code).toBe(0)
      expect(approvals.length).toBe(1)
      expect(approvals[0]![0]).toContain("f.txt")
      expect(existsSync(path.join(cache, "f.txt"))).toBe(true)

      const aborted = await runSandboxed({
        runner: { program: miaoRunPath, prefix: [] },
        command: ["sh", "-c", `echo x > "${path.join(cache, "g.txt")}"`],
        workdirs: [workdir],
        ask: async () => [],
      })
      expect(aborted.code).not.toBe(0)
      expect(aborted.denied.length).toBe(1)
      expect(existsSync(path.join(cache, "g.txt"))).toBe(false)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(cache, { recursive: true, force: true })
    }
  })
})

// The hidden `miao __sandbox-run` entry point reuses the same runner the
// compiled binary self-executes, so exercising it here covers the released path
// without needing a packaged build.
const withInlineRunner = process.platform === "darwin" && addonNative !== undefined ? describe : describe.skip

withInlineRunner("sandbox runner in the main binary", () => {
  test("runs a command inside the workdir", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-sbx-inline-"))
    try {
      const code = await sandboxRun(["--workdir", dir, "--", "sh", "-c", `echo ok > "${dir}/ok.txt"`])
      expect(code).toBe(0)
      expect(existsSync(path.join(dir, "ok.txt"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("writes a deny report for blocked paths", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miao-sbx-inline-"))
    const report = path.join(os.tmpdir(), `miao-deny-inline-${process.pid}.json`)
    try {
      const escape = path.join(dir, "..", `inline-escape-${process.pid}.txt`)
      const code = await sandboxRun(["--workdir", dir, "--deny-report", report, "--", "sh", "-c", `echo x > "${escape}"`])
      expect(code).not.toBe(0)
      const parsed = (await Bun.file(report).json()) as { denied: string[] }
      expect(parsed.denied.some((item) => item.includes(`inline-escape-${process.pid}.txt`))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(report, { force: true })
    }
  })
})

const describeFallback = process.env.MIAO_NATIVE ? describe.skip : describe

describeFallback("native dispatchers", () => {
  test("falls back to the TS implementation when MIAO_NATIVE is unset", () => {
    expect(process.env.MIAO_NATIVE).toBeUndefined()
    const content = "line1\nline2\nline3\n"
    expect(replace(content, "line2", "CHANGED")).toBe(replaceTs(content, "line2", "CHANGED"))
    expect(outcome(() => replace(content, "missing", "x"))).toEqual(outcome(() => replaceTs(content, "missing", "x")))

    const chunks: UpdateFileChunk[] = [{ old_lines: ["line2"], new_lines: ["CHANGED"] }]
    expect(deriveNewContentsFromChunks("f.txt", chunks, content)).toEqual(
      deriveNewContentsFromChunksTs("f.txt", chunks, content),
    )
  })
})

test("native edit is active when MIAO_NATIVE=1 and the addon is built", () => {
  if (process.env.MIAO_NATIVE !== "1" || !native) return
  expect(nativeEditActive()).toBe(true)
})

test("resolves miao-run from MIAO_RUN and reports availability", () => {
  if (!existsSync(miaoRunPath)) return
  const previous = process.env.MIAO_RUN
  process.env.MIAO_RUN = miaoRunPath
  try {
    expect(resolveSandboxRunner()).toEqual({ program: miaoRunPath, prefix: [] })
    if (process.platform === "darwin") expect(sandboxAvailable()).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.MIAO_RUN
    else process.env.MIAO_RUN = previous
  }
})

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
