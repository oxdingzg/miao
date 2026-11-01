import { expect, test } from "bun:test"
import { sessionTitle, tabTitle, terminalTitle } from "../src/util/terminal-title"

test("an untitled Session's tab carries its request until the title arrives", () => {
  // A generated title needs an auxiliary model call, which a long first turn
  // never gets to; the request itself is available immediately.
  expect(tabTitle({ title: "New session - 2026-10-27T06:29:51.376Z", prompt: "复盘一下 roadmap\n再看看昨天" })).toBe(
    "复盘一下 roadmap 再看看昨天",
  )
  expect(tabTitle({ title: "New session", prompt: "fix the tab title" })).toBe("fix the tab title")
  // Nothing asked yet.
  expect(tabTitle({ title: "New session", prompt: "" })).toBe("miao")
  expect(tabTitle({ title: "New session" })).toBe("miao")
})

test("a generated title outranks the request it was made from", () => {
  expect(tabTitle({ title: "复盘miao统一Rust单二进制进度", prompt: "复盘一下 roadmap" })).toBe(
    "复盘miao统一Rust单二进制进度",
  )
})

test("preserves Chinese titles whose UTF-8 bytes overlap C1 controls", () => {
  expect(terminalTitle("检查 H3-2 云台相机拍照与照片拉取功能")).toBe("检查 H3-2 云台相机拍照与照片拉取功能")
})

test("removes OSC terminators, sequence introducers, and multiline controls", () => {
  expect(terminalTitle("检查\u0007相机\u001b\\功能\u009c\n雷达\t驱动")).toBe("检查 相机 \\功能 雷达 驱动")
  expect(terminalTitle("\u0000\u0018\u001a\u007f\u009c \n")).toBe("miao")
  expect(terminalTitle("")).toBe("miao")
})

test("truncates by grapheme without splitting emoji or combining characters", () => {
  for (const char of ["😀", "👨‍👩‍👧‍👦", "e\u0301"]) {
    expect(terminalTitle("a".repeat(36) + char + "b".repeat(4))).toBe("a".repeat(36) + char + "…")
    expect(terminalTitle(char.repeat(40))).toBe(char.repeat(40))
  }
})

test("an idle Session reads as its plain title so done and ready are one glance", () => {
  expect(sessionTitle({ title: "检查miao", status: { type: "idle" } })).toBe("检查miao")
  expect(sessionTitle({ title: "检查miao", status: undefined })).toBe("检查miao")
})

test("a running turn marks the title without a clock that rewrites the tab", () => {
  // The elapsed time lives in the composer footer. A tab is read by glancing at
  // it, so the title keeps the Session name and a static marker instead of
  // spending the visible space on a number that changes every second.
  expect(sessionTitle({ title: "检查miao", status: { type: "busy", since: 1_000_000 } })).toBe(
    "⏳ working · 检查miao",
  )
  expect(sessionTitle({ title: "检查miao", status: { type: "busy" } })).toBe("⏳ working · 检查miao")
})

test("a retry names itself instead of a generic working", () => {
  expect(
    sessionTitle({
      title: "检查miao",
      status: { type: "retry", attempt: 2, message: "provider refused", next: 1 },
    }),
  ).toBe("⏳ retrying · 检查miao")
})
