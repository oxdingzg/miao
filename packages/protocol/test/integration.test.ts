import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Integration } from "@miao/schema/integration"
import { OAuthConnectPayload } from "../src/groups/integration"

test("OAuth connection accepts older clients without additional prompt inputs", () => {
  expect(Schema.decodeUnknownSync(OAuthConnectPayload)({ methodID: "oauth" })).toEqual({
    methodID: Integration.MethodID.make("oauth"),
    inputs: {},
  })
})

test("OAuth connection preserves supplied prompt inputs and still validates values", () => {
  expect(Schema.decodeUnknownSync(OAuthConnectPayload)({ methodID: "oauth", inputs: { tenant: "company" } })).toEqual({
    methodID: Integration.MethodID.make("oauth"),
    inputs: { tenant: "company" },
  })
  expect(() => Schema.decodeUnknownSync(OAuthConnectPayload)({ methodID: "oauth", inputs: { tenant: 123 } })).toThrow()
  expect(() => Schema.decodeUnknownSync(OAuthConnectPayload)({ inputs: {} })).toThrow()
})
