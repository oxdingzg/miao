import { describe, expect, test } from "bun:test"
import { parseAnswers } from "../src/router"

const color = {
  question: "Which color?",
  options: [
    { label: "Red", description: "" },
    { label: "Blue", description: "" },
    { label: "Green", description: "" },
  ],
}

describe("parseAnswers", () => {
  test("maps option numbers to labels", () => {
    expect(parseAnswers([color], "2")).toEqual([["Blue"]])
  })

  test("accepts several numbers only for multi-select questions", () => {
    expect(parseAnswers([{ ...color, multiSelect: true }], "1,3")).toEqual([["Red", "Green"]])
    expect(parseAnswers([color], "1,3")).toBe("第 1 个问题只能选一个")
  })

  test("treats non-numeric text as a custom answer unless custom answers are off", () => {
    expect(parseAnswers([color], "purple please")).toEqual([["purple please"]])
    expect(parseAnswers([{ ...color, custom: false }], "purple")).toBe("第 1 个问题只能选编号")
  })

  test("splits answers for several questions on semicolons", () => {
    expect(parseAnswers([color, color], "1；3")).toEqual([["Red"], ["Green"]])
    expect(parseAnswers([color, color], "1")).toBe("有 2 个问题，请用 ; 分开每个问题的回答")
  })

  test("rejects out-of-range numbers", () => {
    expect(parseAnswers([color], "4")).toBe("第 1 个问题的编号要在 1-3 之间")
  })
})
