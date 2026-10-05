import { describe, expect, test } from "bun:test"
import { SessionCommand } from "@miao/core/session/command"

describe("SessionCommand.renderTemplate", () => {
  test("substitutes positional placeholders and trims quotes", () => {
    expect(SessionCommand.renderTemplate("Review $1 with $2", '"a.ts" fast')).toBe("Review a.ts with fast")
  })

  test("lets the last positional placeholder capture the rest", () => {
    expect(SessionCommand.renderTemplate("Do $1 then $2", "one two three")).toBe("Do one then two three")
  })

  test("supports $ARGUMENTS and appends arguments when there is no placeholder", () => {
    expect(SessionCommand.renderTemplate("Fix: $ARGUMENTS", "the bug")).toBe("Fix: the bug")
    expect(SessionCommand.renderTemplate("Explain this.", "extra context")).toBe("Explain this.\n\nextra context")
    expect(SessionCommand.renderTemplate("Explain this.", "  ")).toBe("Explain this.")
  })
})

describe("SessionCommand.files", () => {
  test("extracts @file and @agent mentions but ignores emails and code spans", () => {
    const names = SessionCommand.files("Read @src/a.ts and @agent, mail a@b.com, skip `@nope`").map((match) => match[1])
    expect(names).toEqual(["src/a.ts", "agent"])
  })
})

describe("SessionCommand.shell", () => {
  test("extracts !`...` shell substitutions", () => {
    expect(SessionCommand.shell("Run !`git status --short` then stop").map((match) => match[1])).toEqual([
      "git status --short",
    ])
  })
})
