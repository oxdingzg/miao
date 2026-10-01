/**
 * DeepSeek bills off-peak usage at half the peak rate, so a session that runs
 * outside Beijing business hours costs less than the static price table quotes.
 * That table is the peak rate; every other provider bills flat, which is why
 * this returns a factor rather than a price.
 */

/** DeepSeek's peak windows as minutes-of-day: Beijing time, Monday to Friday. */
const PEAK_WINDOWS = [
  { start: 9 * 60, end: 12 * 60 },
  { start: 14 * 60, end: 18 * 60 },
]
/** `Intl` reports weekdays as short English names regardless of the locale used. */
const PEAK_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]
const DEFAULT_TIMEZONE = "Asia/Shanghai"
const OFF_PEAK_MULTIPLIER = 0.5

export namespace CachePricing {
  /** Extra provider ids billed on DeepSeek's schedule, for gateways that resell it. */
  export const KV = "cache_pricing_providers"
  export const DEFAULT: ReadonlyArray<string> = []
}

export type CachePricingOptions = {
  timezone?: string
  /** Provider ids treated as DeepSeek even though their id does not say so. */
  providers?: ReadonlyArray<string>
}

/** Whether `at` falls outside DeepSeek's peak windows, read in `timezone`. */
export function isOffPeak(at: number, timezone = DEFAULT_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // `hour12: false` renders midnight as 24 in some ICU builds; h23 cannot.
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  )
  // Weekends are off-peak all day, which is what the empty window list encodes.
  if (!PEAK_WEEKDAYS.includes(parts.weekday ?? "")) return true
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return !PEAK_WINDOWS.some((window) => minutes >= window.start && minutes < window.end)
}

/** The factor to bill a turn at, given the static price table quotes peak rates. */
export function priceMultiplier(
  at: number,
  providerID: string,
  modelID: string,
  options?: CachePricingOptions,
) {
  if (!isDeepSeek(providerID, modelID, options?.providers)) return 1
  return isOffPeak(at, options?.timezone) ? OFF_PEAK_MULTIPLIER : 1
}

/** Whether this model's rate varies by time of day at all. */
export function isTimeOfDayPriced(providerID: string, modelID: string, options?: CachePricingOptions) {
  return isDeepSeek(providerID, modelID, options?.providers)
}

/** DeepSeek reached directly, named in the model id, or listed in the overrides. */
function isDeepSeek(providerID: string, modelID: string, extra?: ReadonlyArray<string>) {
  const provider = providerID.toLowerCase()
  return (
    provider.includes("deepseek") ||
    modelID.toLowerCase().startsWith("deepseek/") ||
    (extra ?? []).some((id) => id.toLowerCase() === provider)
  )
}
