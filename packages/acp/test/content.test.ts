import { describe, expect, test } from "bun:test"
import { promptFromContent, slashCommand, userContent } from "../src/content"

const png = "iVBORw0KGgo="

describe("promptFromContent", () => {
  test("joins text blocks and keeps user-only text away from the model", () => {
    expect(
      promptFromContent([
        { type: "text", text: "first" },
        { type: "text", text: "for the user", annotations: { audience: ["user"] } },
        { type: "text", text: "second" },
      ]),
    ).toEqual({ text: "first\n\nsecond" })
  })

  test("turns images, file links and blobs into prompt files", () => {
    expect(
      promptFromContent([
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: png },
        { type: "resource_link", uri: "file:///work/README.md", name: "README.md" },
        { type: "resource_link", uri: "zed://file?path=/work/src/a.ts", name: "a.ts" },
        {
          type: "resource",
          resource: { uri: "file:///work/b.bin", mimeType: "application/octet-stream", blob: "AAE=" },
        },
      ]),
    ).toEqual({
      text: "look",
      files: [
        { uri: `data:image/png;base64,${png}`, name: "image" },
        { uri: "file:///work/README.md", name: "README.md" },
        { uri: "file:///work/src/a.ts", name: "a.ts" },
        { uri: "data:application/octet-stream;base64,AAE=", name: "b.bin" },
      ],
    })
  })

  test("inlines embedded text resources with their path and line", () => {
    expect(
      promptFromContent([
        { type: "resource", resource: { uri: "file:///work/a.ts#L12", mimeType: "text/plain", text: "const a = 1" } },
        { type: "resource", resource: { uri: "untitled:notes", text: "note" } },
        { type: "resource_link", uri: "https://example.com/doc", name: "doc" },
      ]),
    ).toEqual({ text: "[/work/a.ts:12]\nconst a = 1\n\n[untitled:notes]\nnote\n\nhttps://example.com/doc" })
  })
})

describe("slashCommand", () => {
  test("splits the command name from its arguments", () => {
    expect(slashCommand({ text: "  /review  the diff now " })).toEqual({ name: "review", args: "the diff now" })
    expect(slashCommand({ text: "/compact" })).toEqual({ name: "compact", args: "" })
    expect(slashCommand({ text: "not /a command" })).toBeUndefined()
    expect(slashCommand({ text: "/" })).toBeUndefined()
  })
})

describe("userContent", () => {
  test("replays text and attachments as ACP content", () => {
    expect(
      userContent({
        text: "hello",
        files: [
          { uri: "file:///work/README.md", mime: "text/markdown", name: "README.md" },
          { uri: `data:image/png;base64,${png}`, mime: "image/png", name: "shot.png" },
          { uri: "data:text/plain;base64,aGk=", mime: "text/plain", name: "note.txt" },
        ],
      }),
    ).toEqual([
      { content: { type: "text", text: "hello" } },
      {
        content: { type: "resource_link", uri: "file:///work/README.md", name: "README.md", mimeType: "text/markdown" },
      },
      { content: { type: "image", mimeType: "image/png", data: png, uri: expect.stringContaining("shot.png") } },
      {
        content: {
          type: "resource",
          resource: { uri: expect.stringContaining("note.txt"), mimeType: "text/plain", text: "hi" },
        },
      },
    ])
  })
})
