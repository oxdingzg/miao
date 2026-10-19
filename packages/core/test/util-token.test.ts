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

test("provider metadata is not charged as prompt text", () => {
  const text = "replayed reasoning"
  // Encrypted reasoning is provider bookkeeping. At four characters per token the
  // base64 envelope of a real Session inflated its request roughly twofold, which
  // pushed a fitting prefix onto the staged compaction path.
  expect(
    Token.measureValue({
      type: "reasoning",
      text,
      providerMetadata: { openai: { reasoningEncryptedContent: "A".repeat(400_000) } },
    }),
  ).toBe(Token.estimate("reasoning") + Token.estimate(text))

  // Ordinary metadata is still part of the prompt-sized value.
  expect(Token.measureValue({ type: "text", text, metadata: { note: "B".repeat(400) } })).toBeGreaterThan(
    Token.estimate("text") + Token.estimate(text),
  )
})
