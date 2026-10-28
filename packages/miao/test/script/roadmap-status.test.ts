import { expect, test } from "bun:test"
import {
  acceptanceRecords,
  itemCode,
  roadmapCodes,
  withEvidence,
} from "../../../../script/github/roadmap-status"

const tracked = new Set(["CFG-02", "RUN-04"])

test("a pull request only advances codes the board tracks", () => {
  expect(roadmapCodes("feat(tui): inspect recovery (RUN-04) and MOD-05", tracked)).toEqual(["RUN-04"])
  expect(roadmapCodes("docs: record CTX-04 acceptance", tracked)).toEqual([])
  expect(roadmapCodes("<!-- miao-roadmap:CFG-02 -->", tracked)).toEqual(["CFG-02"])
})

test("a board item is identified by the code its title opens with", () => {
  expect(itemCode("[CFG-02] 配置来源和生效范围可解释")).toBe("CFG-02")
  expect(itemCode("说明见 [CFG-02]")).toBeUndefined()
})

const body = `### 接手进展（2026-10-28）

状态：进行中；现状：部分实现待收口。

关联证据：[#1589](https://github.com/oxdingzg/miao/pull/1589)。

剩余缺口：

- 未知键与无效值仍被静默忽略。
`

test("evidence is appended to the item's own line, keeping its punctuation", () => {
  const next = withEvidence(body, { number: 1591, url: "https://github.com/oxdingzg/miao/pull/1591" })
  expect(next).toContain(
    "关联证据：[#1589](https://github.com/oxdingzg/miao/pull/1589) [#1591](https://github.com/oxdingzg/miao/pull/1591)。",
  )
  expect(next.split("剩余缺口")[1]).not.toContain("pull/1591")
  expect(next).toContain("- 未知键与无效值仍被静默忽略。")
})

test("recording the same pull request twice leaves the body alone", () => {
  const once = withEvidence(body, { number: 1591, url: "https://github.com/oxdingzg/miao/pull/1591" })
  expect(withEvidence(once, { number: 1591, url: "https://github.com/oxdingzg/miao/pull/1591" })).toBe(once)
})

test("a body without an evidence line is left alone", () => {
  expect(withEvidence("### 接手进展\n\n状态：进行中。", { number: 1, url: "https://x/1" })).toBe(
    "### 接手进展\n\n状态：进行中。",
  )
})

test("acceptance records are read from committed documents", () => {
  expect(acceptanceRecords("现状：完成。\n\nroadmap: CFG-02 done in v0.3.16\n")).toEqual([
    { code: "CFG-02", version: "0.3.16" },
  ])
  expect(acceptanceRecords("roadmap: CFG-02 done in 0.3.16\n")).toEqual([{ code: "CFG-02", version: "0.3.16" }])
  expect(acceptanceRecords("roadmap: CFG-02 in progress\n")).toEqual([])
  expect(acceptanceRecords("- roadmap: CFG-02 done in v0.3.16 and more\n")).toEqual([])
})
