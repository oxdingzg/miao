import { expect, test } from "bun:test"
import { addChineseLink, chineseLink } from "./release-notes"

test("adds the 简体中文 link under the first heading", () => {
  const notes = "## [0.1.4] - 2026-10-04\n\n### Fixed\n- a fix (`abc123`)\n"
  const out = addChineseLink(notes, "v0.1.4")
  expect(out).toBe(
    "## [0.1.4] - 2026-10-04\n\n" +
      "[简体中文](https://github.com/oxdingzg/miao/blob/main/docs/releases/v0.1.4.zh.md)\n\n" +
      "### Fixed\n- a fix (`abc123`)\n",
  )
})

test("uses the given repository", () => {
  expect(chineseLink("v9.9.9", "owner/repo")).toBe(
    "[简体中文](https://github.com/owner/repo/blob/main/docs/releases/v9.9.9.zh.md)",
  )
})

test("falls back to prepending when there is no heading", () => {
  const out = addChineseLink("No notable changes", "v1.0.0")
  expect(out.startsWith("[简体中文](https://github.com/oxdingzg/miao/blob/main/docs/releases/v1.0.0.zh.md)\n\n")).toBe(true)
  expect(out.endsWith("No notable changes")).toBe(true)
})
