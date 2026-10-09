import { describe, expect, test } from "bun:test"
import { renderUnicodeCompact } from "uqr"

// The devices dialog shows the pairing code only when the QR block fits the
// fixed-width dialog box. The old check compared against the raw terminal size
// minus generous paddings, so a normal window wrongly reported "窗口不足以完
// 整显示二维码". These cases pin the replacement budget used by the dialog.
const fits = (qrLines: string[], width: number, height: number) => {
  if (!qrLines.length) return false
  const boundedWidth = Math.min(width, 120)
  const boundedHeight = Math.min(height, 64)
  return (qrLines[0]?.length ?? 0) <= boundedWidth - 4 && qrLines.length + 8 <= boundedHeight - 4
}

const sample = (characters: number) => renderUnicodeCompact("https://relay.example.invalid/control/#pair=" + "a".repeat(characters), { border: 1 }).split("\n")

describe("pairing QR fits the fixed dialog budget", () => {
  test("a typical link fits a normal terminal and the dialog interior", () => {
    const qr = sample(120)
    expect(fits(qr, 140, 44)).toBe(true)
    expect(fits(qr, 116, 40)).toBe(true)
  })

  test("wide terminals stop penalizing the dialog interior", () => {
    const qr = sample(400)
    expect(fits(qr, 240, 60)).toBe(true)
  })

  test("genuinely small windows still fall back to the copy link hint", () => {
    const qr = sample(200)
    expect(fits(qr, 60, 20)).toBe(false)
    expect(fits([], 200, 60)).toBe(false)
  })
})
