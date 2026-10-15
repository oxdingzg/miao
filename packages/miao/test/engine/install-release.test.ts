import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, mkdir, chmod, readlink, rm } from "node:fs/promises"

// Exercise the installer, real archives, checksum tools and a local HTTP peer.
// Windows has its own PowerShell installation path; this is the POSIX script.
test.skipIf(process.platform === "win32")("release installation verifies assets and preserves upgrade rollback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "miao-engine-release-"))
  const asset = `miao-engine-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}.${process.platform === "darwin" ? "zip" : "tar.gz"}`
  const versions = ["1.0.0", "1.0.1"]
  const assets = new Map<string, ArrayBuffer | string>()
  const script = path.resolve(import.meta.dir, "../../../../script/install-engine.sh")
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const body = assets.get(new URL(request.url).pathname)
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body)
    },
  })
  try {
    for (const version of versions) {
      const dir = path.join(root, version)
      await mkdir(dir)
      await Bun.write(path.join(dir, "miao-engine"), `#!/bin/sh\nprintf 'miao-engine ${version}\\n'\n`)
      await chmod(path.join(dir, "miao-engine"), 0o755)
      const archive = path.join(root, `${version}-${asset}`)
      const args = process.platform === "darwin"
        ? ["zip", "-q", archive, "miao-engine"]
        : ["tar", "-czf", archive, "miao-engine"]
      const pack = Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" })
      expect(await pack.exited).toBe(0)
      const bytes = await Bun.file(archive).arrayBuffer()
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      assets.set(`/download/v${version}/${asset}`, bytes)
      assets.set(`/download/v${version}/${asset}.sha256`, `${hash}  ${asset}\n`)
    }
    const home = path.join(root, "home")
    await mkdir(home)
    const install = async (tag: string) => {
      const child = Bun.spawn(["bash", script, "--release", tag], {
        env: { ...process.env, HOME: home, MIAO_ENGINE_RELEASE_BASE_URL: server.url.toString().replace(/\/$/, "") },
        stdout: "pipe", stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const stdout = new Response(child.stdout).text()
      return { code: await child.exited, stderr: await stderr, stdout: await stdout }
    }
    const link = path.join(home, ".local/bin/miao-engine")
    const previous = path.join(home, ".local/share/miao-engine/bin/miao-engine.prev")
    expect((await install("v1.0.0")).code).toBe(0)
    const first = await readlink(link)
    expect((await install("v1.0.1")).code).toBe(0)
    const second = await readlink(link)
    expect(second).not.toBe(first)
    expect(await readlink(previous)).toBe(first)
    const smoke = Bun.spawn([link, "--version"], { stdout: "pipe" })
    expect(await new Response(smoke.stdout).text()).toBe("miao-engine 1.0.1\n")
    expect(await smoke.exited).toBe(0)

    // Tampered or missing manifests must fail before altering either pointer.
    assets.set(`/download/v1.0.0/${asset}.sha256`, `${"0".repeat(64)}  ${asset}\n`)
    expect((await install("v1.0.0")).code).not.toBe(0)
    expect(await readlink(link)).toBe(second)
    expect(await readlink(previous)).toBe(first)
    assets.delete(`/download/v1.0.0/${asset}.sha256`)
    expect((await install("v1.0.0")).code).not.toBe(0)
    expect(await readlink(link)).toBe(second)

    // Execute the actual documented rollback and smoke-test the old binary.
    const rollback = Bun.spawn(["ln", "-sfn", first, link])
    expect(await rollback.exited).toBe(0)
    const restored = Bun.spawn([link, "--version"], { stdout: "pipe" })
    expect(await new Response(restored.stdout).text()).toBe("miao-engine 1.0.0\n")
    expect(await restored.exited).toBe(0)
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
