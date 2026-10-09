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

/** Format an amount already denominated in `code`, without conversion. */
export function amount(value: number, code: string | undefined | null): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: find(code).code }).format(value)
}

/** Convert a USD amount into `code` using the approximate static rate table. */
export function format(usd: number, code: string | undefined | null): string {
  const currency = find(code)
  return amount(usd * currency.rate, currency.code)
}

export type ProviderLike = {
  readonly id: string
  readonly models: Readonly<Record<string, unknown>>
}

/** The model's own billing currency, when a provider declares native prices. */
export function native(
  providers: ReadonlyArray<ProviderLike>,
  providerID: string | undefined,
  modelID: string | undefined,
): string | undefined {
  if (!providerID || !modelID) return undefined
  const model = providers.find((provider) => provider.id === providerID)?.models[modelID]
  if (typeof model !== "object" || model === null) return undefined
  const currency = (model as { currency?: unknown }).currency
  return typeof currency === "string" ? currency : undefined
}

/** Whether a usable per-token rate is quoted for the model at all; an unpriced model projects as an all-zero rate, which reads as free. */
export function priceable(
  providers: ReadonlyArray<ProviderLike>,
  providerID: string | undefined,
  modelID: string | undefined,
): boolean {
  if (!providerID || !modelID) return false
  const model = providers.find((provider) => provider.id === providerID)?.models[modelID]
  if (typeof model !== "object" || model === null) return false
  const cost = (model as { cost?: unknown }).cost
  if (typeof cost !== "object" || cost === null) return false
  const rates = cost as { input?: unknown; output?: unknown }
  if (typeof rates.input !== "number" || typeof rates.output !== "number") return false
  return rates.input > 0 || rates.output > 0
}

export * as Currency from "./currency"
