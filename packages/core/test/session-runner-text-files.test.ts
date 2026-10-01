import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { DateTime, Effect } from "effect"
import { FSUtil } from "@miao/core/fs-util"
import { LayerNode } from "@miao/core/effect/layer-node"
import { SessionMessage } from "@miao/core/session/message"
import { inlineTextFiles } from "@miao/core/session/runner/materialize-files"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

const user = (files: { uri: string; mime: string; name?: string }[]) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "look at these",
    files,
    time: { created: DateTime.makeUnsafe(0) },
  })

describe("inlineTextFiles", () => {
  it.live("inlines text attachments and keeps real media", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const dir = tmp.path
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(dir, "note.txt"), "hello from a note")
            await fs.writeFile(path.join(dir, "code.ts"), ["line 1", "line 2", "line 3", "line 4"].join("\n"))
            await fs.writeFile(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]))
            await fs.mkdir(path.join(dir, "folder"))
            await fs.writeFile(path.join(dir, "folder", "inside.md"), "x")
          })
          const url = (name: string) => pathToFileURL(path.join(dir, name)).href
          const range = new URL(url("code.ts"))
          range.searchParams.set("start", "2")
          range.searchParams.set("end", "3")
          const fsutil = yield* FSUtil.Service
          const [message] = yield* inlineTextFiles(fsutil, [
            user([
              { uri: url("note.txt"), mime: "text/plain", name: "note.txt" },
              // Extension lookup calls a TypeScript file an MPEG transport stream.
              { uri: range.href, mime: "video/mp2t", name: "code.ts" },
              { uri: url("blob.bin"), mime: "application/octet-stream", name: "blob.bin" },
              { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", name: "shot.png" },
              { uri: `data:text/plain;base64,${Buffer.from("from data").toString("base64")}`, mime: "text/plain" },
              { uri: url("folder"), mime: "application/x-directory", name: "folder" },
              { uri: url("missing.txt"), mime: "text/plain", name: "missing.txt" },
            ]),
          ])
          if (message?.type !== "user") throw new Error("expected a user message")

          expect(message.text).toContain("hello from a note")
          expect(message.text).toContain("line 2\nline 3")
          expect(message.text).not.toContain("line 1")
          expect(message.text).not.toContain("line 4")
          expect(message.text).toContain("from data")
          expect(message.text).toContain("inside.md")
          expect(message.text).toContain("[attachment unavailable: missing.txt]")
          expect(message.files?.map((file) => file.name)).toEqual(["blob.bin", "shot.png"])
        }),
      ),
    ),
  )
})
