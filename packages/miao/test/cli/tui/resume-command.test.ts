import { expect, test } from "bun:test"
import { resumeCommand } from "../../../src/cli/tui/resume-command"

test("preview continuation uses its own executable instead of the stable installation", () => {
  expect(resumeCommand("/home/user/.local/share/miao/bin/.versions/build/miao", "miao-preview")).toBe(
    "/home/user/.local/share/miao/bin/.versions/build/miao",
  )
})

test("source continuation includes Bun conditions and its entrypoint", () => {
  expect(resumeCommand("/usr/local/bin/bun", "/workspace/miao/packages/miao/src/index.ts")).toBe(
    "/usr/local/bin/bun --conditions=browser /workspace/miao/packages/miao/src/index.ts",
  )
})

test("continuation quotes paths containing shell metacharacters", () => {
  expect(resumeCommand('/home/user/my preview/$build/"miao"')).toBe('"/home/user/my preview/\\$build/\\"miao\\""')
})
