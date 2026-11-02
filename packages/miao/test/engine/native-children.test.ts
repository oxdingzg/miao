import { describe, expect, test } from "bun:test"
import { childrenOf } from "@/engine/native-engine"

describe("childrenOf", () => {
  // The engine answers `session_children` with an object. Reading it as a bare
  // list reported "no children" for every delegation, which silently dropped a
  // delegated Session's spend from the run total (#2236).
  test("reads the children out of the object the engine answers", () => {
    const answer = {
      session_id: "ses_parent",
      children: [{ session_id: "ses_parent/sub-1" }, { session_id: "ses_parent/sub-2" }],
      truncated: false,
    }
    expect(childrenOf(answer).map((child) => child["session_id"])).toEqual([
      "ses_parent/sub-1",
      "ses_parent/sub-2",
    ])
  })

  test("answers an empty list for a Session with no children", () => {
    expect(childrenOf({ session_id: "ses_solo", children: [], truncated: false })).toEqual([])
  })

  test("does not mistake a bare list for the answer", () => {
    expect(childrenOf([{ session_id: "ses_parent/sub-1" }])).toEqual([])
  })

  test("drops entries that are not objects", () => {
    expect(childrenOf({ children: [null, "ses_parent/sub-1", { session_id: "ses_parent/sub-2" }] })).toEqual([
      { session_id: "ses_parent/sub-2" },
    ])
  })

  test("answers an empty list for anything else", () => {
    expect(childrenOf(undefined)).toEqual([])
    expect(childrenOf(null)).toEqual([])
    expect(childrenOf("ses_parent")).toEqual([])
  })
})
