import { expect, test } from "bun:test"
import { terminalTitle } from "../src/util/terminal-title"

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
