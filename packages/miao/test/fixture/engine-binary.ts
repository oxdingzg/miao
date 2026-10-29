import { link, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Windows cannot launch a TypeScript shebang. Cache a real executable outside
// each isolated test directory; one content-addressed build serves every suite.
export const engineFake = await executable("engine-fake.ts")
export const engineReplayFake = await executable("engine-replay-fake.ts")

async function executable(name: string) {
  const source = path.join(import.meta.dir, name)
  if (process.platform !== "win32") return source
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(source).bytes())
    .update(await Bun.file(import.meta.path).bytes())
    .update(Bun.version)
    .update(process.execPath)
    .digest("hex")
  const directory = path.join(os.tmpdir(), "miao-engine-fixture", digest)
  await mkdir(directory, { recursive: true })
  const binary = path.join(directory, "engine-fake.exe")
  if (await Bun.file(binary).exists()) return binary
  const temporary = path.join(directory, crypto.randomUUID() + ".exe")
  const child = Bun.spawn([process.execPath, "build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", source, "--outfile", temporary], {
    stdout: "pipe", stderr: "pipe",
  })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(`Could not compile engine fixture (${code}): ${output} ${error}`)
  await link(temporary, binary).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  })
  await rm(temporary)
  return binary
}
