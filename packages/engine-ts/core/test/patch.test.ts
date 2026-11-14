import { describe, expect, test } from "bun:test"
import { Patch } from "@miao/core/patch"

describe("Patch", () => {
  test("parses add, update, and delete hunks", () => {
    expect(
      Patch.parse(
        "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch",
      ),
    ).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update",
        path: "update.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
        movePath: undefined,
      },
      { type: "delete", path: "delete.txt" },
    ])
  })

  test("strips a heredoc wrapper", () => {
    expect(Patch.parse("cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF")).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("derives fuzzy line updates while preserving BOM", () => {
    const update = Patch.derive("update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n")
    expect(update).toEqual({ content: "new\n", bom: true })
    expect(Patch.joinBom(update.content, update.bom)).toBe("\uFEFFnew\n")
  })

  test("matches EOF-anchored chunks from the end", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ).content,
    ).toBe("marker\nmiddle\nmarker changed\nend\n")
  })

  test("parses the EOF marker inside update chunks", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
      },
    ])
  })

  test("appends an insertion after a trailing blank line", () => {
    expect(Patch.derive("update.txt", [{ oldLines: [], newLines: ["inserted"] }], "line1\n\n")).toEqual({
      content: "line1\n\ninserted\n",
      bom: false,
    })
    expect(Patch.derive("update.txt", [{ oldLines: [], newLines: ["inserted"] }], "line1\n")).toEqual({
      content: "line1\ninserted\n",
      bom: false,
    })
  })

  test("keeps the derive reference and the wired backend equal", () => {
    const inputs: Array<Parameters<typeof Patch.derive>> = [
      ["update.txt", [{ oldLines: ["line2"], newLines: ["CHANGED"] }], "line1\nline2\nline3\n"],
      ["update.txt", [{ oldLines: [], newLines: ["inserted"] }], "line1\n\n"],
      ["update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n"],
      [
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ],
    ]
    for (const [path, chunks, original] of inputs) {
      expect(Patch.derive(path, chunks, original)).toEqual(Patch.deriveTs(path, chunks, original))
    }
  })

  test("reports a missing chunk the same way through both backends", () => {
    expect(() => Patch.derive("update.txt", [{ oldLines: ["missing"], newLines: ["x"] }], "line1\nline2\n")).toThrow(
      "Failed to find expected lines in update.txt:\nmissing",
    )
    expect(() => Patch.deriveTs("update.txt", [{ oldLines: ["missing"], newLines: ["x"] }], "line1\nline2\n")).toThrow(
      "Failed to find expected lines in update.txt:\nmissing",
    )
  })

  test("rejects malformed hunk bodies", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch")).toThrow(
      "Invalid add file line",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")).toThrow(
      "Invalid patch line",
    )
  })
})
