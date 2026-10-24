import { expect, test } from "bun:test"
import { statusSegments } from "../../src/util/status-line"

const input = {
  model: "Gemini 3.8 Flash (Google account)",
  context: "Context ~40% left",
  directory: "~/workspace/code/github/miao",
  branch: "fix/native-model-state",
  agent: "Build · 2/4 agents",
  shortcut: "ctrl+p commands",
}

test("wide status lines show model, capacity, directory, branch and agents in order", () => {
  const result = statusSegments(input, 160)
  expect(result.map((item) => item.text).join(" · ")).toBe(Object.values(input).join(" · "))
})

test("narrow terminals preserve model and context and stay on one line", () => {
  for (const width of [40, 60, 80, 100, 120]) {
    const result = statusSegments(input, width)
    expect(result.map((item) => item.key)).toContain("model")
    expect(result.map((item) => item.key)).toContain("context")
    expect(result.find((item) => item.key === "context")?.text).toBe(input.context)
    expect(Bun.stringWidth(result.map((item) => item.text).join(" · "))).toBeLessThanOrEqual(width)
  }
})

test("Unicode paths and long branch names fit by terminal cells without broken graphemes", () => {
  const result = statusSegments(
    { ...input, directory: "~/项目/模型测试/🐈‍⬛/很长的目录名称", branch: "feat/一条非常长的分支名称" },
    90,
  )
  expect(Bun.stringWidth(result.map((item) => item.text).join(" · "))).toBeLessThanOrEqual(90)
  expect(result.find((item) => item.key === "directory")?.text).toContain("…")
})
