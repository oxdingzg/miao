// Reuse Intl instances across messages; formatting must not allocate one per render.
const formatters = new Map<string, ReturnType<typeof timeFormatter>>()

export function createTimeFormatter(locale?: string, timeZone?: string) {
  const key = `${locale ?? ""}:${timeZone ?? ""}`
  const cached = formatters.get(key)
  if (cached) return cached
  const next = timeFormatter(locale, timeZone)
  if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!)
  formatters.set(key, next)
  return next
}

function timeFormatter(locale?: string, timeZone?: string) {
  const clock = { hour: "2-digit", minute: "2-digit", timeZone } as const
  const time = new Intl.DateTimeFormat(locale, clock)
  const date = new Intl.DateTimeFormat(locale, { ...clock, month: "2-digit", day: "2-digit" })
  const year = new Intl.DateTimeFormat(locale, { ...clock, year: "numeric", month: "2-digit", day: "2-digit" })
  const detail = new Intl.DateTimeFormat(locale, {
    ...clock,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  })
  const calendar = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const shortDate = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone })
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  const valid = (input: number | null | undefined): input is number =>
    typeof input === "number" && Number.isFinite(input) && Math.abs(input) <= 8.64e15

  return {
    compact(input: number | null | undefined, now = Date.now()) {
      if (!valid(input)) return "—"
      const at = calendar.formatToParts(input)
      const today = calendar.formatToParts(now)
      const field = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find((part) => part.type === type)?.value
      const sameYear = field(at, "year") === field(today, "year")
      const sameDay =
        sameYear && field(at, "month") === field(today, "month") && field(at, "day") === field(today, "day")
      return (sameDay ? time : sameYear ? date : year).format(input)
    },
    precise(input: number | null | undefined) {
      return valid(input) ? detail.format(input) : "—"
    },
    relative(input: number | null | undefined, now = Date.now()) {
      if (!valid(input)) return "—"
      const elapsed = Math.max(0, now - input)
      if (elapsed < 60_000) return relative.format(0, "minute")
      if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), "minute")
      if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), "hour")
      if (elapsed < 7 * 86_400_000) return relative.format(-Math.floor(elapsed / 86_400_000), "day")
      return shortDate.format(input)
    },
  }
}
