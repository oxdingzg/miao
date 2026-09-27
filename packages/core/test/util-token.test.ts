import { expect, test } from "bun:test"
import { Token } from "@miao/core/util/token"

test("count returns a BPE token count", () => {
  expect(Token.count("hello world")).toBeGreaterThan(0)
  expect(Token.count("")).toBe(0)
})

test("count is more accurate than the character heuristic for CJK text", () => {
  const cjk = "清洁智能六院"

  expect(Token.count(cjk)).toBeGreaterThan(Token.estimate(cjk))
})
