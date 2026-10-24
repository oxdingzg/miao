import { expect, test } from "bun:test"
import path from "node:path"
import { chmod, readlink } from "node:fs/promises"
import { resolveEngine } from "@/engine/discovery"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform === "win32")("preview installation and rollback retain each CLI's paired engine", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "installed")
  const launcher = path.join(tmp.path, "miao-preview")
  const install = path.resolve(import.meta.dir, "../../../../script/install-local.sh")
  const publish = async (version: string) => {
    const id = crypto.randomUUID()
    const cli = path.join(tmp.path, id)
    const engine = cli + "-engine"
    await Bun.write(cli, `#!/bin/sh\ncase "$1" in --version) echo 9.9.9;; --build-id) echo ${id};; *) exit 1;; esac\n`)
    await Bun.write(engine, `#!/bin/sh\ncase "$1" in --version) echo 'miao-engine ${version}';; --capabilities) echo '{"name":"miao-engine","version":"${version}","protocol":2,"schema":12,"routesSchema":2,"build":"${id}"}';; *) exit 1;; esac\n`)
    await chmod(cli, 0o755)
    await chmod(engine, 0o755)
    const child = Bun.spawn(["bash", install, "--binary", cli, "--engine-binary", engine], {
      env: { ...process.env, MIAO_PREVIEW_INSTALL_DIR: directory, MIAO_PREVIEW_LINK: launcher }, stdout: "pipe", stderr: "pipe",
    })
    const errors = await new Response(child.stderr).text()
    return { status: await child.exited, errors }
  }
  expect((await publish("9.9.9")).status).toBe(0)
  const first = await readlink(launcher)
  const paired = path.join(path.dirname(first), "miao-engine")
  expect(resolveEngine({ executable: launcher, environment: {} })?.binary).toBe(paired)
  expect((await publish("9.9.9")).status).toBe(0)
  const next = await readlink(launcher)
  expect(next).not.toBe(first)
  expect(await readlink(path.join(directory, "miao.prev"))).toBe(first)
  expect(resolveEngine({ executable: first, environment: {} })?.binary).toBe(paired)
  const invalid = await publish("8.8.8")
  expect(invalid.status).not.toBe(0)
  expect(invalid.errors).toContain("versions must match")
  expect(await readlink(launcher)).toBe(next)
}, 15_000)
