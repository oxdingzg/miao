import { expect, test } from "bun:test"
import { chmod, mkdtemp, readlink, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const installer = new URL("../../../../script/install-engine.sh", import.meta.url).pathname

async function install(home: string, binary: string) {
  const child = Bun.spawn(["bash", installer, "--binary", binary], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function execute(binary: string) {
  const child = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  return output.trim()
}

// The fixtures differ in bytes/behavior but deliberately share a release
// version. That is exactly the collision a branch-preview install must handle.
test.skipIf(process.platform === "win32")("same-version builds remain independently rollbackable", async () => {
  const home = await mkdtemp(join(tmpdir(), "engine-install-"))
  try {
    for (const name of ["A", "B"]) {
      await Bun.write(
        join(home, name),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'miao-engine 0.2.3'; else echo '${name}'; fi\n`,
      )
      await chmod(join(home, name), 0o755)
    }
    const link = join(home, ".local/bin/miao-engine")
    const previous = join(home, ".local/share/miao-engine/bin/miao-engine.prev")
    expect((await install(home, join(home, "A"))).code).toBe(0)
    const targetA = await readlink(link)
    expect((await install(home, join(home, "B"))).code).toBe(0)
    const targetB = await readlink(link)
    expect(targetA).not.toBe(targetB)
    expect(await execute(link)).toBe("B")
    expect(await execute(previous)).toBe("A")

    // Installing the identical build again must not lose the previous A.
    expect((await install(home, join(home, "B"))).code).toBe(0)
    expect(await readlink(previous)).toBe(targetA)
    expect(await execute(previous)).toBe("A")

    // Execute the advertised rollback, not merely inspect the symlinks.
    await unlink(link)
    await symlink(await readlink(previous), link)
    expect(await execute(link)).toBe("A")

    await Bun.write(join(home, "broken"), "#!/bin/sh\nexit 7\n")
    await chmod(join(home, "broken"), 0o755)
    expect((await install(home, join(home, "broken"))).code).not.toBe(0)
    expect(await readlink(link)).toBe(targetA)
    expect(await execute(link)).toBe("A")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
