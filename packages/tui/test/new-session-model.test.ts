import { describe, expect, test } from "bun:test"
import { newSessionModel } from "../src/util/model"

const footer = { providerID: "google", modelID: "gemini-3.8-flash" }

describe("newSessionModel", () => {
  test("carries the operator-bound route of a native Session", () => {
    expect(
      newSessionModel({
        session: {
          execution: { selection: "operator" },
          model: { id: "gemini-pro", providerID: "native-engine", variant: "medium" },
        },
        selected: footer,
        variant: "high",
      }),
    ).toEqual({ id: "gemini-pro", providerID: "native-engine", variant: "medium" })
  })

  test("uses the footer selection for a TypeScript Session", () => {
    expect(
      newSessionModel({
        session: { execution: { selection: "user" }, model: { id: "gpt-5", providerID: "openai" } },
        selected: footer,
        variant: "high",
      }),
    ).toEqual({ id: "gemini-3.8-flash", providerID: "google", variant: "high" })
  })

  test("omits the variant when the footer has none", () => {
    expect(newSessionModel({ selected: footer })).toEqual({ id: "gemini-3.8-flash", providerID: "google" })
  })

  test("has nothing to carry when neither a Session nor a footer selection exists", () => {
    expect(newSessionModel({ session: { execution: { selection: "operator" } } })).toBeUndefined()
  })
})
