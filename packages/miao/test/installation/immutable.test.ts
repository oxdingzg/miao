import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, readlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

// Native fixture compilation runs in CI or on the build host, never the workstation.
test.skipIf(process.platform === "win32")(
  "installer retains the old build for an active window and its later children",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miao-immutable-"))
    const install = path.resolve(import.meta.dir, "../../../../install")
    const destination = path.join(directory, "installed")
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const binaries = await Promise.all(
      ids.map(async (id) => {
        const outfile = path.join(directory, id)
        const build = Bun.spawn(
          [
            process.execPath,
            "build",
            path.join(import.meta.dir, "fixture-build.ts"),
            "--compile",
            "--outfile",
            outfile,
            "--define",
            `MIAO_BUILD_ID=${JSON.stringify(id)}`,
            "--no-compile-autoload-bunfig",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-tsconfig",
            "--no-compile-autoload-package-json",
          ],
          { cwd: directory, stdout: "pipe", stderr: "pipe" },
        )
        const errors = await new Response(build.stderr).text()
        expect(await build.exited, errors).toBe(0)
        if (process.platform === "darwin") {
          expect(await Bun.spawn(["codesign", "--force", "--sign", "-", outfile]).exited).toBe(0)
        }
        return outfile
      }),
    )
    const publish = async (binary: string) => {
      const child = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
        env: { ...process.env, MIAO_INSTALL_DIR: destination },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(0)
    }
    await publish(binaries[0])
    const launcher = path.join(destination, "miao")
    const old = Bun.spawn([launcher], { stdin: "pipe", stdout: "pipe" })
    const reader = old.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value).trim()).toBe(ids[0])
    try {
      await publish(binaries[1])
      expect(await readlink(launcher)).toContain(ids[1])
      expect(old.exitCode).toBeNull()
      old.stdin.write("child\n")
      old.stdin.flush()
      const child = await reader.read()
      expect(new TextDecoder().decode(child.value).trim()).toBe(ids[0])
      const next = Bun.spawn([launcher, "--build-id"], { stdout: "pipe" })
      expect((await new Response(next.stdout).text()).trim()).toBe(ids[1])
      expect(await next.exited).toBe(0)
      // Reinstalling the same build cannot replace its retained inode.
      await Promise.all([publish(binaries[1]), publish(binaries[1])])
      const invalid = Bun.spawn(["bash", install, "--binary", "/bin/false", "--no-modify-path"], {
        env: { ...process.env, MIAO_INSTALL_DIR: destination },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await invalid.exited).not.toBe(0)
      expect(await readlink(launcher)).toContain(ids[1])
    } finally {
      old.stdin.end()
      old.kill()
      await old.exited
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
