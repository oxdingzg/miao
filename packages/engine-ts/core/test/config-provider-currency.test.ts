import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProvider } from "@miao/core/config/provider"

test("accepts a provider-level and model-level billing currency", () => {
  const info = Schema.decodeUnknownSync(ConfigProvider.Info)({
    currency: "CNY",
    models: { flash: { currency: "USD" } },
  })

  expect(info.currency).toBe("CNY")
  expect(info.models?.flash?.currency).toBe("USD")
})
