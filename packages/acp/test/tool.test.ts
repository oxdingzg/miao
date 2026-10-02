import { describe, expect, test } from "bun:test"
import { completedToolUpdate, failedToolUpdate, pendingToolCall, runningToolUpdate, toolKind } from "../src/tool"

const cwd = "/work"

describe("tool mapping", () => {
  test("classifies V2 tools", () => {
    expect(
      [
        "bash",
        "read",
        "edit",
        "write",
        "apply_patch",
        "glob",
        "grep",
        "webfetch",
        "websearch",
        "task",
        "todowrite",
      ].map(toolKind),
    ).toEqual(["execute", "read", "edit", "edit", "edit", "search", "search", "fetch", "search", "think", "other"])
  })

  test("shows the shell command and where it runs", () => {
    expect(pendingToolCall({ callID: "c1", name: "bash", input: { command: "ls -la", workdir: "src" }, cwd })).toEqual({
      toolCallId: "c1",
      title: "ls -la",
      kind: "execute",
      status: "pending",
      locations: [{ path: "/work/src" }],
      rawInput: { command: "ls -la", workdir: "src" },
    })
    expect(pendingToolCall({ callID: "c1", name: "bash", input: { command: "ls" }, cwd }).rawInput).toEqual({
      command: "ls",
      cwd,
    })
  })

  test("resolves file locations and apply_patch targets", () => {
    expect(runningToolUpdate({ callID: "c2", name: "read", input: { path: "src/a.ts" }, cwd }).locations).toEqual([
      { path: "/work/src/a.ts" },
    ])
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** Add File: /abs/b.ts\n+x\n*** End Patch"
    const call = pendingToolCall({ callID: "c3", name: "apply_patch", input: { patchText: patch }, cwd })
    expect(call.title).toBe("2 files")
    expect(call.locations).toEqual([{ path: "/work/a.ts" }, { path: "/abs/b.ts" }])
  })

  test("completes with text, images and an edit diff", () => {
    const update = completedToolUpdate(
      { callID: "c4", name: "edit", input: { path: "a.ts", oldString: "a", newString: "b" }, cwd },
      [
        { type: "text", text: "Edited a.ts" },
        { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png" },
      ],
      { structured: {}, result: undefined },
    )
    expect(update.status).toBe("completed")
    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "Edited a.ts" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: "AAAA" } },
      { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
    ])
    expect(update.rawOutput).toEqual({ output: "Edited a.ts" })
  })

  test("fails with the error text", () => {
    const update = failedToolUpdate({ callID: "c5", name: "bash", input: { command: "false" }, cwd }, "exit 1")
    expect(update.status).toBe("failed")
    expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "exit 1" } }])
  })
})
