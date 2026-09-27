import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { createRequire } from "module"
import os from "os"
import path from "path"

const require = createRequire(import.meta.url)
const nativePath = path.join(import.meta.dir, "../../../../crates/miao-native/miao-native.node")

type Native = {
  gitRevParse(path: string, rev: string): string
  gitRevParseAsync(path: string, rev: string): Promise<string>
  gitBlob(path: string, rev: string, file: string): { content: string; binary: boolean }
  gitBlobAsync(path: string, rev: string, file: string): Promise<{ content: string; binary: boolean }>
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

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miao-git-native-"))
  git(["init", "-q"], dir)
  writeFileSync(path.join(dir, "file.txt"), "hello\nworld\n")
  writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 255, 254]))
  git(["add", "-A"], dir)
  git(["commit", "-qm", "init"], dir)
  return dir
}

const withRepo = (run: (dir: string) => void | Promise<void>) => async () => {
  const dir = repo()
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const withNative = native ? describe : describe.skip

withNative("native git parity", () => {
  test(
    "gitRevParse matches git rev-parse",
    withRepo((dir) => {
      expect(native!.gitRevParse(dir, "HEAD")).toBe(git(["rev-parse", "HEAD"], dir).trim())
    }),
  )

  test(
    "gitRevParseAsync matches the sync call",
    withRepo(async (dir) => {
      expect(await native!.gitRevParseAsync(dir, "HEAD")).toBe(native!.gitRevParse(dir, "HEAD"))
    }),
  )

  test(
    "gitBlob matches git show for text",
    withRepo((dir) => {
      const blob = native!.gitBlob(dir, "HEAD", "file.txt")
      expect(blob.binary).toBe(false)
      expect(blob.content).toBe(git(["show", "HEAD:file.txt"], dir))
    }),
  )

  test(
    "gitBlobAsync matches the sync call",
    withRepo(async (dir) => {
      expect(await native!.gitBlobAsync(dir, "HEAD", "file.txt")).toEqual(native!.gitBlob(dir, "HEAD", "file.txt"))
    }),
  )

  test(
    "gitBlob flags binary content",
    withRepo((dir) => {
      expect(native!.gitBlob(dir, "HEAD", "bin.dat").binary).toBe(true)
    }),
  )

  test(
    "gitBlob errors for a missing path",
    withRepo((dir) => {
      expect(() => native!.gitBlob(dir, "HEAD", "missing.txt")).toThrow()
    }),
  )

  test(
    "native reads are not slower than the git subprocess",
    withRepo((dir) => {
      const median = (run: () => void, n = 15) => {
        for (let index = 0; index < 3; index++) run()
        const times: number[] = []
        for (let index = 0; index < n; index++) {
          const start = performance.now()
          run()
          times.push(performance.now() - start)
        }
        times.sort((a, b) => a - b)
        return times[Math.floor(times.length / 2)]!
      }

      const nativeMs = median(() => void native!.gitRevParse(dir, "HEAD"))
      const subprocessMs = median(() => void git(["rev-parse", "HEAD"], dir))
      console.log(`git rev-parse: native ${nativeMs.toFixed(3)}ms vs subprocess ${subprocessMs.toFixed(3)}ms`)

      expect(nativeMs).toBeLessThan(subprocessMs * 1.5 + 0.5)
    }),
  )
})
