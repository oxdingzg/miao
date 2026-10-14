import { encode } from "uqr"

export type DeviceQRRun = { readonly fg: string; readonly bg: string; text: string }

const DARK = "#000000"
const LIGHT = "#ffffff"

/**
 * One "▀" glyph per module column: the glyph's foreground paints the top module
 * and the cell background paints the bottom module. Explicit colors per cell
 * keep dark modules black on a white quiet zone, and each cell's background is
 * drawn by the terminal itself so a font's block-glyph coverage cannot cut the
 * QR apart. Runs of identical cells merge into one span to bound node count.
 * uqr already pads the matrix with the requested quiet-zone border.
 */
export function deviceQRRuns(value: string, border = 2): DeviceQRRun[][] {
  const { data } = encode(value, { border })
  const total = data.length
  const lines: DeviceQRRun[][] = []
  for (let y = 0; y < total; y += 2) {
    const line: DeviceQRRun[] = []
    for (let x = 0; x < total; x++) {
      const fg = data[y][x] ? DARK : LIGHT
      const bg = (data[y + 1]?.[x] ?? false) ? DARK : LIGHT
      const last = line[line.length - 1]
      if (last && last.fg === fg && last.bg === bg) last.text += "▀"
      else line.push({ fg, bg, text: "▀" })
    }
    lines.push(line)
  }
  return lines
}
