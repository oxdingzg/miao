import { expect, test } from "bun:test"
import { tabTitle, terminalTitle } from "../src/util/terminal-title"

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
