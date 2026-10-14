import { describe, expect, test } from "bun:test"
import { deviceQRRuns, type DeviceQRRun } from "../../src/util/device-qr"

const DARK = "#000000"
const LIGHT = "#ffffff"

function width(line: readonly DeviceQRRun[]) {
  return line.reduce((total, run) => total + run.text.length, 0)
}

function cell(runs: readonly DeviceQRRun[][], x: number, y: number) {
  const line = runs[Math.floor(y / 2)]
  let offset = 0
  for (const run of line) {
    if (x < offset + run.text.length) return { fg: run.fg, bg: run.bg }
    offset += run.text.length
  }
  throw new Error(`no run covers column ${x}`)
}

describe("util.deviceQRRuns", () => {
  const runs = deviceQRRuns("miao://pair#demo", 2)

  test("every line covers the same full-width grid of glyphs", () => {
    expect(runs.length).toBeGreaterThan(10)
    for (const line of runs) {
      expect(line.length).toBeGreaterThan(0)
      expect(width(line)).toBe(width(runs[0]))
      for (const run of line) {
        expect(run.text).toMatch(/^▀+$/)
        expect([DARK, LIGHT]).toContain(run.fg)
        expect([DARK, LIGHT]).toContain(run.bg)
      }
    }
  })

  test("quiet zone is light on every edge", () => {
    const total = width(runs[0])
    for (let x = 0; x < total; x++) {
      expect(cell(runs, x, 0)).toEqual({ fg: LIGHT, bg: LIGHT })
      expect(cell(runs, x, runs.length * 2 - 1)).toEqual({ fg: LIGHT, bg: LIGHT })
    }
    for (const line of runs) {
      expect(line[0].fg).toBe(LIGHT)
      expect(line[line.length - 1].bg).toBe(LIGHT)
    }
  })

  test("dark modules render as black foreground over white background", () => {
    // The finder's top edge is dark over its white inner ring.
    const edge = cell(runs, 5, 2)
    expect(edge.fg).toBe(DARK)
    expect(edge.bg).toBe(LIGHT)
    // The finder's center 3x3 stays dark two rows lower.
    const center = cell(runs, 5, 4)
    expect(center.fg).toBe(DARK)
    // The finder's inner white band stays light beside the center block.
    const ring = cell(runs, 3, 4)
    expect(ring.fg).toBe(LIGHT)
  })

  test("runs merge adjacent identical cells", () => {
    for (const line of runs) {
      expect(line.length).toBeLessThan(width(line))
      for (let i = 1; i < line.length; i++) {
        const previous = line[i - 1]
        expect(previous.fg !== line[i].fg || previous.bg !== line[i].bg).toBe(true)
      }
    }
  })
})
