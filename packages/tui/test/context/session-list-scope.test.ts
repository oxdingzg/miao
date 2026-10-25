import { expect, test } from "bun:test"
import { sessionListScope } from "../../src/context/session-list-scope"

test("project filtering falls back to the current directory until project identity is available", () => {
  expect(sessionListScope({ scope: "project", directory: "/workspace/miao" })).toEqual({
    directory: "/workspace/miao",
  })
})
