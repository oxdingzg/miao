import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

async function run(input: {
  version?: string
  workspace?: string
  override?: string
  channel?: string
  bump?: string
}) {
  const root = await mkdtemp(path.join(tmpdir(), "miao-version-"))
  try {
    await mkdir(path.join(root, "packages/script/src"), { recursive: true })
    await mkdir(path.join(root, "packages/miao"), { recursive: true })
    await mkdir(path.join(root, ".github"), { recursive: true })
    await Bun.write(
      path.join(root, "package.json"),
      JSON.stringify({
        type: "module",
        version: input.version ?? "0.0.13",
        packageManager: `bun@${Bun.version}`,
        workspaces: { packages: ["packages/*"] },
      }),
    )
    await Bun.write(
      path.join(root, "packages/miao/package.json"),
      JSON.stringify({ version: input.workspace ?? "0.0.13" }),
    )
    await Bun.write(path.join(root, ".github/TEAM_MEMBERS"), "")
    await Bun.write(
      path.join(root, "packages/script/src/index.ts"),
      await Bun.file(path.join(import.meta.dir, "../src/index.ts")).text(),
    )
    await symlink(path.resolve(import.meta.dir, "../../../node_modules"), path.join(root, "node_modules"))
    const env: NodeJS.ProcessEnv = { ...process.env, MIAO_CHANNEL: input.channel ?? "main" }
    delete env.MIAO_VERSION
    delete env.MIAO_BUMP
    delete env.MIAO_RELEASE
    if (input.override) env.MIAO_VERSION = input.override
    if (input.bump) env.MIAO_BUMP = input.bump
    const child = Bun.spawn([Bun.which("bun")!, "packages/script/src/index.ts"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      code: await child.exited,
      output: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("preview and release builds read the same root version", async () => {
  for (const channel of ["main", "latest"]) {
    const result = await run({ channel })
    expect(result.code).toBe(0)
    expect(result.output).toContain('"version": "0.0.13"')
  }
})

test("a mismatched environment override cannot change the version", async () => {
  const result = await run({ override: "0.0.5" })
  expect(result.code).toBe(1)
  expect(result.error).toContain("differs from package.json 0.0.13")
})

test("workspace version drift fails before building", async () => {
  const result = await run({ workspace: "0.0.1" })
  expect(result.code).toBe(1)
  expect(result.error).toContain("packages/miao/package.json version 0.0.1 differs")
})

test("implicit version bumps cannot create another version source", async () => {
  const result = await run({ bump: "patch" })
  expect(result.code).toBe(1)
  expect(result.error).toContain("MIAO_BUMP is no longer supported")
})
