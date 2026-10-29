import { describe, expect, it } from "bun:test"
import { renderDetail, renderList } from "@/cli/cmd/memory"

const now = Date.parse("2026-10-28T12:00:00Z")
const document = {
  revision: 7,
  notes: {
    "pin-ordering": {
      title: "Pins sort above recency",
      kind: "repo_fact",
      body: "Pinned sessions sort first, then by updated time.",
      derivation: "read packages/core/src/session.ts",
      updated_at_ms: Date.parse("2026-10-27T09:00:00Z"),
      expires_at_ms: null,
      sources: [{ path: "packages/core/src/session.ts" }],
    },
    "pref-theme": {
      title: "Prefers the dark theme",
      kind: "preference",
      body: "User prefers dark.",
      updated_at_ms: Date.parse("2026-10-28T10:00:00Z"),
      expires_at_ms: Date.parse("2026-10-20T10:00:00Z"),
      sources: [],
    },
  },
}

describe("memory command", () => {
  it("lists every note with kind, expiry, and source count", () => {
    const text = renderList(document, now)
    expect(text).toContain("2 note(s), store revision 7")
    expect(text).toContain("pin-ordering")
    expect(text).toContain("repo_fact")
    expect(text).toContain("Pins sort above recency")
    expect(text).toContain("[1 source(s)]")
    // The preference expired before `now`, so it reads as expired; the fact has no expiry.
    expect(text).toContain("pref-theme")
    expect(text).toContain("(expired)")
  })

  it("reports an empty store and an empty document alike", () => {
    expect(renderList({}, now)).toBe("No memory notes stored.")
    expect(renderList({ notes: {} }, now)).toBe("No memory notes stored.")
  })

  it("renders one note's full detail and undefined for an unknown id", () => {
    const detail = renderDetail(document, "pin-ordering", now)
    expect(detail).toBeDefined()
    expect(detail).toContain("pin-ordering (repo_fact)")
    expect(detail).toContain("Pinned sessions sort first")
    expect(detail).toContain("derived: read packages/core/src/session.ts")
    expect(detail).toContain("packages/core/src/session.ts")
    expect(renderDetail(document, "missing", now)).toBeUndefined()
  })
})
