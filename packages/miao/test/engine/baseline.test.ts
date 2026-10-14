import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assessBaselineArtifacts, baselineContract, baselineTask, initializeBaselineWorkspace } from "@/engine/baseline"

async function fixture(id: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "miao-baseline-"))
  const directory = path.join(root, id)
  await initializeBaselineWorkspace(directory, id)
  return { directory, close: () => rm(root, { recursive: true, force: true }) }
}

test("real workspace oracles reject the initial defects and accept verified source repairs", async () => {
  const repairs = [
    { id: "small-edit", files: { "src/add.ts": "export function add(a: number, b: number) { return a + b }\n" } },
    {
      id: "multi-file",
      files: {
        "src/config.ts": "export function enabled(value: unknown) { return value === true }\n",
        "src/display.ts": "export function display(value: boolean) { return value ? 'ON' : 'OFF' }\n",
      },
    },
    {
      id: "test-repair",
      files: {
        "src/tokens.ts":
          "export function tokens(value: string) { return value.split(',').map((part) => part.trim()).filter(Boolean) }\n",
      },
    },
  ]
  for (const repair of repairs) {
    const workspace = await fixture(repair.id)
    try {
      const before = await assessBaselineArtifacts(workspace.directory, repair.id)
      expect(before.artifactPass).toBe(false)
      expect(before.check?.exit).toBe(1)
      await Promise.all(
        Object.entries(repair.files).map(([file, text]) => Bun.write(path.join(workspace.directory, file), text)),
      )
      const after = await assessBaselineArtifacts(workspace.directory, repair.id)
      expect(after.artifactPass).toBe(true)
      expect(after.check?.exit).toBe(0)
      expect(after.executionVerdict).toBe("unverified")
    } finally {
      await workspace.close()
    }
  }
}, 30_000)

test("tampering with an immutable test oracle prevents execution rather than producing a false pass", async () => {
  const workspace = await fixture("small-edit")
  try {
    await Bun.write(
      path.join(workspace.directory, "test/oracle.test.ts"),
      "await Bun.write('executed-marker', 'bad')\n",
    )
    const result = await assessBaselineArtifacts(workspace.directory, "small-edit")
    expect(result.artifactPass).toBe(false)
    expect(result.check).toBeNull()
    expect(await Bun.file(path.join(workspace.directory, "executed-marker")).exists()).toBe(false)
  } finally {
    await workspace.close()
  }
})

test("the interruption artifact oracle exposes repeated side effects and never asserts execution parity by itself", async () => {
  const workspace = await fixture("stream-interruption")
  try {
    const invoke = () =>
      Bun.spawn(["bun", "action.ts"], { cwd: workspace.directory, stdout: "ignore", stderr: "pipe" }).exited
    expect(await invoke()).toBe(0)
    const once = await assessBaselineArtifacts(workspace.directory, "stream-interruption")
    expect(once.artifactPass).toBe(true)
    expect(once.executionVerdict).toBe("unverified")
    expect(once.requiredReceipts).toEqual(["provider.interrupted"])
    expect(await invoke()).toBe(0)
    expect((await assessBaselineArtifacts(workspace.directory, "stream-interruption")).artifactPass).toBe(false)
  } finally {
    await workspace.close()
  }
})

test("read-only changes and denied-path changes fail artifact checks; fixture initialization preserves existing work", async () => {
  for (const id of ["read-only", "permission-denial"]) {
    const workspace = await fixture(id)
    try {
      expect((await assessBaselineArtifacts(workspace.directory, id)).artifactPass).toBe(true)
      await Bun.write(
        path.join(workspace.directory, id === "read-only" ? "new.txt" : "protected/record.txt"),
        "changed",
      )
      expect((await assessBaselineArtifacts(workspace.directory, id)).artifactPass).toBe(false)
      await expect(initializeBaselineWorkspace(workspace.directory, id)).rejects.toThrow()
      expect(
        await Bun.file(path.join(workspace.directory, id === "read-only" ? "new.txt" : "protected/record.txt")).text(),
      ).toBe("changed")
    } finally {
      await workspace.close()
    }
  }
})

test("the frozen suite has eight distinct contracts and returned task metadata cannot rewrite its oracle", async () => {
  const before = baselineContract()
  expect(new Set(before.tasks.map((task) => task.id)).size).toBe(8)
  expect(baselineTask("long-session").followups).toHaveLength(4)
  const task = baselineTask("small-edit")
  task.files["test/oracle.test.ts"] = ""
  expect(baselineContract()).toEqual(before)
  expect(baselineTask("small-edit").files["test/oracle.test.ts"]).not.toBe("")
})
