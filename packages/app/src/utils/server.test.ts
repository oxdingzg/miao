import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, authorizationHeader } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to miao", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "miao", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("miao:secret"))
  })
})

describe("authorizationHeader", () => {
  test("presents a bearer token for a loopback engine attachment", () => {
    expect(authorizationHeader({ url: "http://127.0.0.1:4096", token: "tok" })).toEqual({
      Authorization: "Bearer tok",
    })
  })

  test("prefers the bearer token when both credentials are present", () => {
    expect(authorizationHeader({ url: "http://127.0.0.1:4096", token: "tok", password: "secret" })).toEqual({
      Authorization: "Bearer tok",
    })
  })

  test("falls back to basic credentials, then to no credentials", () => {
    expect(authorizationHeader({ url: "http://127.0.0.1:4096", username: "kit", password: "secret" })).toEqual({
      Authorization: `Basic ${btoa("kit:secret")}`,
    })
    expect(authorizationHeader({ url: "http://127.0.0.1:4096" })).toBeUndefined()
  })
})
