import { describe, expect, it } from "bun:test"
import { DESCRIPTION } from "@miao/core/tool/task"

describe("task tool guidance", () => {
  it("states the four net-benefit axes for delegating (AGT-03 C1)", () => {
    expect(DESCRIPTION).toContain("four axes")
    expect(DESCRIPTION).toContain("parallelism")
    expect(DESCRIPTION).toContain("context volume")
    expect(DESCRIPTION).toContain("specialization")
    expect(DESCRIPTION).toContain("redo cost")
  })

  it("names when NOT to delegate", () => {
    expect(DESCRIPTION).toContain("Do not delegate")
    expect(DESCRIPTION).toContain("self-sufficient prompt")
  })
})
