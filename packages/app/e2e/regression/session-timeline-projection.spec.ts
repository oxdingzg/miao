import { expect, test } from "@playwright/test"
import { assistant, setup, text, tool, user, type Message } from "../utils/session-v2"
import {
  assistantMessage,
  setupTimeline,
  status,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test.describe("session timeline projection", () => {
  test("renders every admitted tool family and hides timeline-only exclusions", async ({ page }) => {
    const parts = [
      toolPart("prt_01_read", "read", "completed", { filePath: "src/a.ts" }),
      toolPart("prt_02_glob", "glob", "completed", { path: ".", pattern: "**/*.ts" }),
      toolPart("prt_03_grep", "grep", "completed", { path: ".", pattern: "value" }),
      toolPart("prt_04_list", "list", "completed", { path: "src" }),
      toolPart("prt_webfetch", "webfetch", "completed", { url: "https://example.com" }),
      toolPart(
        "prt_websearch",
        "websearch",
        "completed",
        { query: "timeline stability" },
        { output: "https://example.com/result" },
      ),
      toolPart("prt_task", "task", "completed", { description: "Inspect timeline", subagent_type: "explore" }),
      toolPart(
        "prt_bash",
        "bash",
        "completed",
        { command: "printf stable" },
        { output: "stable", title: "printf stable" },
      ),
      editPart("prt_edit"),
      toolPart("prt_write", "write", "completed", { filePath: "src/new.ts", content: "export const stable = true\n" }),
      patchPart("prt_patch"),
      toolPart("prt_todo", "todowrite", "completed", { todos: [{ content: "Hidden", status: "pending" }] }),
      toolPart(
        "prt_question",
        "question",
        "completed",
        { questions: [{ question: "Keep stable?", header: "Stability", options: [] }] },
        { metadata: { answers: [["Yes"]] } },
      ),
      toolPart("prt_skill", "skill", "completed", { name: "stability" }),
      toolPart("prt_custom", "custom_mcp_tool", "completed", { target: "timeline", count: 2 }),
    ]
    await setupTimeline(page, { messages: [userMessage(), assistantMessage(parts)] })

    await expect(
      page.locator('[data-timeline-part-ids="prt_01_read,prt_02_glob,prt_03_grep,prt_04_list"]'),
    ).toBeVisible()
    for (const id of [
      "prt_webfetch",
      "prt_websearch",
      "prt_task",
      "prt_bash",
      "prt_edit",
      "prt_write",
      "prt_patch",
      "prt_question",
      "prt_skill",
      "prt_custom",
    ]) {
      await expect(page.locator(`[data-timeline-part-id="${id}"]`).first(), id).toBeVisible()
    }
    await expect(page.locator('[data-timeline-part-id="prt_todo"]')).toHaveCount(0)
  })

  test("projects gaps, compaction dividers, assistant parts, and errors together", async ({ page }) => {
    const compacted: Message = {
      id: "msg_projection_compaction",
      type: "compaction",
      reason: "auto",
      summary: "Compacted earlier work",
      recent: "Recent work",
      time: { created: 1700000002500 },
    }
    await setup(page, {
      messages: [
        user("Continue after compaction"),
        { ...assistant([text("Before compaction")]), error: { type: "unknown", message: "Visible provider failure" } },
        compacted,
        user("Second turn", { id: "msg_2000_second_user", created: 1700000005000 }),
        assistant([text("Second response")], { id: "msg_2001_second_assistant", created: 1700000006000 }),
      ],
    })
    await expect(page.locator('[data-timeline-row="TurnDivider"]')).toHaveCount(1)
    await expect(page.getByText("Session compacted", { exact: true })).toBeVisible()
    await expect(page.getByText("Visible provider failure")).toBeVisible()
    await expect(page.getByText("Second response", { exact: true })).toBeVisible()
    await expect(page.locator('[data-timeline-row="TurnGap"]')).toBeVisible()
  })

  test("renders user comment instructions and historical multi-file patch details", async ({ page }) => {
    const files = Array.from({ length: 11 }, (_, index) => patchFile(`src/diff-${index}.ts`, "update"))
    await setup(page, {
      messages: [
        user("Regarding src/a.ts lines 4 through 8: Keep this stable. Continue after the comment."),
        assistant([
          tool(
            "call_historical_patch",
            "apply_patch",
            "completed",
            { files: files.map((file) => file.filePath) },
            "Applied patches",
            { files },
          ),
        ]),
      ],
      settings: { editToolPartsExpanded: true },
    })
    await expect(page.getByText(/Keep this stable/)).toBeVisible()
    const patch = page.locator('[data-timeline-part-id="call_historical_patch"]')
    await expect(patch).toContainText("diff-0.ts")
    await expect(patch).toContainText("diff-10.ts")
  })

  test("renders interruption independently when the turn is not compacted", async ({ page }) => {
    const user = userMessage()
    const before = assistantMessage([{ id: "prt_before", type: "text", text: "Before" }], {
      id: "msg_1001_before",
      error: { name: "MessageAbortedError", data: { message: "Stopped" } },
    })
    const after = assistantMessage([{ id: "prt_after", type: "text", text: "After" }], {
      id: "msg_1002_after",
      created: 1700000003000,
    })
    await setupTimeline(page, { messages: [user, before, after] })
    page.on("console", (msg) => {
      const text = msg.text()
      if (text.includes("INTERRUPT-DEBUG")) console.log("BROWSER-LOG:", text.substring(0, 200))
    })

    // The structural locator is i18n-independent; the virtualizer may mount
    // rows progressively under parallel workers.
    await expect(page.getByTestId("timeline-divider-interrupted")).toBeVisible({ timeout: 30_000 })
    const rows = await page
      .locator('[data-timeline-row="AssistantPart"], [data-timeline-row="TurnDivider"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-timeline-row")))
    expect(rows).toEqual(["AssistantPart", "TurnDivider", "AssistantPart"])
  })


  test("renders user image, file attachment, file reference, and agent reference", async ({ page }) => {
    const rich: Message = {
      ...user("Use @explore with @src/a.ts and inspect the attachments"),
      files: [
        {
          mime: "image/png",
          name: "pixel.png",
          uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
        { mime: "application/json", name: "tsconfig.json", uri: "data:application/json;base64,e30=" },
        { mime: "text/plain", name: "a.ts", uri: "src/a.ts", source: { text: "@src/a.ts", start: 18, end: 27 } },
      ],
      agents: [{ name: "explore", source: { text: "@explore", start: 4, end: 12 } }],
    }
    await setup(page, { messages: [rich, assistant()] })
    await expect(page.getByAltText("pixel.png")).toBeVisible()
    await expect(page.getByText("tsconfig.json")).toBeVisible()
    await expect(page.getByText("@src/a.ts", { exact: true })).toBeVisible()
    await expect(page.getByText("@explore", { exact: true })).toBeVisible()
  })
})

function editPart(id: string) {
  return toolPart(
    id,
    "edit",
    "completed",
    { filePath: "src/a.ts" },
    {
      metadata: {
        filediff: {
          file: "src/a.ts",
          additions: 1,
          deletions: 1,
          before: "export const value = 1\n",
          after: "export const value = 2\n",
        },
      },
    },
  )
}

function patchPart(id: string) {
  return toolPart(
    id,
    "apply_patch",
    "completed",
    { files: ["src/a.ts", "src/b.ts"] },
    {
      metadata: {
        files: [
          patchFile("src/a.ts", "update"),
          patchFile("src/b.ts", "add"),
          patchFile("src/old.ts", "delete"),
          { ...patchFile("src/moved.ts", "move"), move: "src/new-place.ts" },
        ],
      },
    },
  )
}

function patchFile(filePath: string, type: "add" | "update" | "delete" | "move") {
  return {
    filePath,
    relativePath: filePath,
    type,
    additions: type === "delete" ? 0 : 1,
    deletions: type === "add" ? 0 : 1,
    before: type === "add" ? undefined : "export const before = true\n",
    after: type === "delete" ? undefined : "export const after = true\n",
  }
}
