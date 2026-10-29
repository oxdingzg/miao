import { expect, test } from "bun:test"
import { chmod, copyFile, lstat, mkdtemp, mkdir, open, readlink, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const installer = path.resolve(import.meta.dir, "../../../../install")

test.skipIf(process.platform === "win32").each(["engine", "tui"])(
  "installing a %s preserves open executable files and retained builds",
  async (kind) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-companion-"))
    const destination = path.join(directory, "installed")
    const name = `miao-${kind}`
    const launcher = path.join(destination, name)
    const contents = ["A", "B"].map((value) => `#!/bin/sh\necho '${value}'\n`)
    const binaries = await Promise.all(
      contents.map(async (content, index) => {
        const file = path.join(directory, String(index))
        await Bun.write(file, content)
        await chmod(file, 0o755)
        return file
      }),
    )
    const cli = path.join(directory, "cli")
    await Bun.write(
      cli,
      '#!/bin/sh\nif [ "$1" = "--build-id" ]; then echo 11111111-1111-4111-8111-111111111111; else echo 0.3.16; fi\n',
    )
    await chmod(cli, 0o755)
    const publish = async (binary: string) => {
      const child = Bun.spawn(["bash", installer, "--binary", cli, `--${kind}-binary`, binary, "--no-modify-path"], {
        env: { ...process.env, MIAO_INSTALL_DIR: destination },
        stdout: "ignore",
        stderr: "pipe",
      })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    }
    await mkdir(destination)
    // Migrate an existing regular executable without truncating its open inode.
    await copyFile(binaries[0], launcher)
    const legacy = await open(launcher, "r")
    try {
      const before = await legacy.stat()
      await publish(binaries[1])
      expect((await legacy.stat()).ino).toBe(before.ino)
      expect(await legacy.readFile("utf8")).toBe(contents[0])
      expect((await lstat(launcher)).isSymbolicLink()).toBe(true)
      expect(await Bun.file(launcher).text()).toBe(contents[1])
      const retained = await readlink(launcher)
      const inode = (await stat(retained)).ino
      await publish(binaries[0])
      expect(await Bun.file(retained).text()).toBe(contents[1])
      expect(await readlink(launcher)).not.toBe(retained)
      await Promise.all([publish(binaries[1]), publish(binaries[1])])
      expect(await readlink(launcher)).toBe(retained)
      expect((await stat(retained)).ino).toBe(inode)
      // Reinstalling from the launcher itself must also leave its target intact.
      await publish(launcher)
      expect((await stat(retained)).ino).toBe(inode)
    } finally {
      await legacy.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
