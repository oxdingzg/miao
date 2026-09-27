import { expect, test } from "bun:test"
import { render } from "@miao/core/skill/guidance"

test("lists no skills when none are available", () => {
  expect(render([])).toContain("No skills are currently available.")
})

test("lists names and descriptions within budget", () => {
  const text = render([{ name: "review", description: "Review code changes" }])

  expect(text).toContain("<name>review</name>")
  expect(text).toContain("<description>Review code changes</description>")
  expect(text).not.toContain("Descriptions are omitted")
})

test("omits descriptions past the budget but keeps every name", () => {
  const skills = Array.from({ length: 40 }, (_, index) => ({
    name: `skill-${index}`,
    description: "x".repeat(200),
  }))
  const text = render(skills)

  expect(text).toContain("<name>skill-0</name>")
  expect(text).toContain("<name>skill-39</name>")
  expect(text).toContain("Descriptions are omitted")
})
