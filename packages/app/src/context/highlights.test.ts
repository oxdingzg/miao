import { describe, expect, test } from "bun:test"
import { loadReleaseHighlights } from "./highlights"

const releases = [
  { tag_name: "v0.0.33", name: "v0.0.33", body: "Future notes", draft: false, prerelease: false },
  { tag_name: "v0.0.32", name: "v0.0.32", body: "Local defaults", draft: false, prerelease: false },
  { tag_name: "v0.0.31", name: "v0.0.31", body: "Previous notes", draft: false, prerelease: false },
]

describe("miao release highlights", () => {
  test("selects the installed version and excludes future and previously seen releases", () => {
    expect(loadReleaseHighlights(releases, "0.0.32", "0.0.31")).toEqual([
      { title: "v0.0.32", description: "Local defaults" },
    ])
  })

  test("unpublished builds and downgrades never show unrelated release notes", () => {
    expect(loadReleaseHighlights(releases, "0.0.34", "0.0.31")).toEqual([])
    expect(loadReleaseHighlights(releases, "0.0.31", "0.0.32")).toEqual([])
    expect(loadReleaseHighlights({ releases }, "0.0.32", "0.0.31")).toEqual([])
  })

  test("ignores draft and prerelease notes", () => {
    expect(loadReleaseHighlights([
      { ...releases[1], draft: true },
      { ...releases[1], prerelease: true },
    ], "0.0.32", "0.0.31")).toEqual([])
  })

  test("missing previous versions show only the exact current release", () => {
    expect(loadReleaseHighlights(releases, "v0.0.32", "0.0.1")).toEqual([
      { title: "v0.0.32", description: "Local defaults" },
    ])
  })
})
