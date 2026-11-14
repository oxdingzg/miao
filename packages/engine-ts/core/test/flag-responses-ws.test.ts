import { describe, expect, test } from "bun:test"
import { Flag } from "@miao/core/flag/flag"

const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const clear = { MIAO_RESPONSES_WS: undefined, MIAO_EXPERIMENTAL_RESPONSES_WS: undefined }

describe("Flag.MIAO_RESPONSES_WS", () => {
  test("is on by default so the pooled socket is the default transport", () => {
    withEnv(clear, () => expect(Flag.MIAO_RESPONSES_WS).toBe(true))
  })

  test("MIAO_RESPONSES_WS=0 forces the HTTP transport", () => {
    withEnv({ ...clear, MIAO_RESPONSES_WS: "0" }, () => expect(Flag.MIAO_RESPONSES_WS).toBe(false))
  })

  test("still honours the legacy MIAO_EXPERIMENTAL_RESPONSES_WS kill switch", () => {
    withEnv({ ...clear, MIAO_EXPERIMENTAL_RESPONSES_WS: "0" }, () => expect(Flag.MIAO_RESPONSES_WS).toBe(false))
  })

  test("the current name wins over the legacy one", () => {
    withEnv({ MIAO_RESPONSES_WS: "1", MIAO_EXPERIMENTAL_RESPONSES_WS: "0" }, () =>
      expect(Flag.MIAO_RESPONSES_WS).toBe(true),
    )
  })
})
