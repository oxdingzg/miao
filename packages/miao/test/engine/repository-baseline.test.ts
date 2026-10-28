import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assessRepositoryBaseline,
  initializeRepositoryBaseline,
  repositoryBaselineContract,
} from "@/engine/repository-baseline"

const profile = {
  provider: "offline-fixture",
  model: "oracle-validation",
  parameters: { temperature: 0 },
  agent: "build",
  permissionHash: "a".repeat(64),
  toolSurfaceHash: "b".repeat(64),
  repetitions: 3,
  maxElapsedMs: 30_000,
  maxAttempts: 2,
  maxCost: null,
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "miao-repository-baseline-"))
  const original = path.join(root, "original")
  const contract = repositoryBaselineContract(profile)
  await Promise.all(
    contract.tasks.map(async (task) => {
      await Bun.write(
        path.join(original, task.file),
        await Bun.file(path.join(import.meta.dir, "../../../core/src/util", path.basename(task.file))).text(),
      )
    }),
  )
  await Bun.write(path.join(original, "AGENTS.md"), "Preserve unrelated files.\n")
  const archive = process.env.MIAO_REPOSITORY_BASELINE_ARCHIVE ?? path.join(root, "source.tar")
  if (!process.env.MIAO_REPOSITORY_BASELINE_ARCHIVE) {
    const child = Bun.spawn(["tar", "-cf", archive, "-C", original, "."], { stderr: "inherit" })
    expect(await child.exited).toBe(0)
    contract.source.archiveSha256 = createHash("sha256")
      .update(new Uint8Array(await Bun.file(archive).arrayBuffer()))
      .digest("hex")
  }
  return {
    root,
    archive,
    contract: repositoryBaselineContract(profile, contract.source),
    close: () => rm(root, { recursive: true, force: true }),
  }
}

test("frozen repository tasks reject seeded defects and accept repairs without claiming execution parity", async () => {
  const workspace = await fixture()
  try {
    for (const task of workspace.contract.tasks) {
      const directory = path.join(workspace.root, task.id)
      const metadata = await initializeRepositoryBaseline({ ...workspace, directory, task: task.id })
      const before = await assessRepositoryBaseline({ directory, metadata, contract: workspace.contract })
      expect(before.artifactPass).toBe(false)
      expect(before.check?.exit).toBe(1)
      const file = path.join(directory, task.file)
      await Bun.write(file, (await Bun.file(file).text()).replace(task.seeded, task.before))
      const after = await assessRepositoryBaseline({ directory, metadata, contract: workspace.contract })
      expect(after.artifactPass).toBe(true)
      expect(after.executionVerdict).toBe("unverified")
      expect(after.changed).toEqual([task.file])
      expect(after.source.commit).toBe(workspace.contract.source.commit)
      expect(metadata.profile.maxCost).toBeNull()
    }
  } finally {
    await workspace.close()
  }
}, 60_000)

test("immutable file changes and symlink replacement prevent verifier execution", async () => {
  const workspace = await fixture()
  try {
    const task = workspace.contract.tasks[0]
    const directory = path.join(workspace.root, "tamper")
    const metadata = await initializeRepositoryBaseline({ ...workspace, directory, task: task.id })
    const file = path.join(directory, task.file)
    await Bun.write(file, "await Bun.write('executed-marker', 'bad'); export const lazy = () => {};\n")
    await Bun.write(path.join(directory, "AGENTS.md"), "Changed authority\n")
    const result = await assessRepositoryBaseline({ directory, metadata, contract: workspace.contract })
    expect(result.artifactPass).toBe(false)
    expect(result.check).toBeNull()
    expect(result.unexpected).toContain("AGENTS.md")
    expect(await Bun.file(path.join(directory, "executed-marker")).exists()).toBe(false)
    await rm(file)
    await symlink(path.join(workspace.root, "original", task.file), file)
    expect((await assessRepositoryBaseline({ directory, metadata, contract: workspace.contract })).check).toBeNull()
  } finally {
    await workspace.close()
  }
}, 60_000)

test("source identity, verifier, metadata and profile validation reject mismatches", async () => {
  const workspace = await fixture()
  try {
    const directory = path.join(workspace.root, "mismatch")
    const contract = structuredClone(workspace.contract)
    contract.source.archiveSha256 = "0".repeat(64)
    await expect(
      initializeRepositoryBaseline({ ...workspace, directory, task: contract.tasks[0].id, contract }),
    ).rejects.toThrow("contract changed")
    const wrongSource = repositoryBaselineContract(profile, contract.source)
    await expect(
      initializeRepositoryBaseline({ ...workspace, directory, task: contract.tasks[0].id, contract: wrongSource }),
    ).rejects.toThrow("frozen source")
    const metadata = await initializeRepositoryBaseline({ ...workspace, directory, task: contract.tasks[0].id })
    await expect(
      initializeRepositoryBaseline({ ...workspace, directory, task: contract.tasks[0].id }),
    ).rejects.toThrow()
    metadata.initialTree[workspace.contract.tasks[0].file].hash = "changed"
    await expect(assessRepositoryBaseline({ ...workspace, directory, metadata })).rejects.toThrow("metadata changed")
    expect(() => repositoryBaselineContract({ ...profile, repetitions: 0 })).toThrow("budget")
    expect(() => repositoryBaselineContract({ ...profile, maxCost: Number.NaN })).toThrow("budget")
    expect(() => repositoryBaselineContract({ ...profile, model: "" })).toThrow("profile")
    expect(repositoryBaselineContract(profile).suiteHash).toBe(repositoryBaselineContract(profile).suiteHash)
    expect(repositoryBaselineContract({ ...profile, maxAttempts: 3 }).suiteHash).not.toBe(
      repositoryBaselineContract(profile).suiteHash,
    )
  } finally {
    await workspace.close()
  }
}, 60_000)
