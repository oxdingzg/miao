export const KV = "currency"

export const DEFAULT = "USD"

export type CurrencyInfo = {
  readonly code: string
  readonly rate: number
  readonly label: string
}

// Approximate per-USD rates used for display only. CNY is tuned toward
// DeepSeek's official implied rate so DeepSeek spend tracks the real bill.
export const ALL: ReadonlyArray<CurrencyInfo> = [
  { code: "USD", rate: 1, label: "US Dollar" },
  { code: "CNY", rate: 7.3, label: "Chinese Yuan" },
  { code: "EUR", rate: 0.92, label: "Euro" },
  { code: "GBP", rate: 0.79, label: "British Pound" },
  { code: "JPY", rate: 155, label: "Japanese Yen" },
  { code: "HKD", rate: 7.8, label: "Hong Kong Dollar" },
  { code: "TWD", rate: 32, label: "New Taiwan Dollar" },
  { code: "KRW", rate: 1380, label: "South Korean Won" },
  { code: "SGD", rate: 1.34, label: "Singapore Dollar" },
  { code: "AUD", rate: 1.52, label: "Australian Dollar" },
  { code: "CAD", rate: 1.38, label: "Canadian Dollar" },
  { code: "INR", rate: 84, label: "Indian Rupee" },
  { code: "RUB", rate: 88, label: "Russian Ruble" },
]

export function find(code: string | undefined | null): CurrencyInfo {
  return ALL.find((item) => item.code === code) ?? ALL[0]!
}

export function format(usd: number, code: string | undefined | null): string {
  const currency = find(code)
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.code }).format(usd * currency.rate)
}

export * as Currency from "./currency"
