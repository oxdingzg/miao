import assert from "node:assert/strict"
import { link, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { windowsCommand } from "../../src/installation/windows"

/** Real compiled Windows host, locked legacy engine, and offline embedded upgrade. */
export async function verifyEmbeddedPairing() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-paired-upgrade-"))
  const executable = path.join(directory, "miao.exe")
  const oldEngine = path.join(directory, "miao-engine.exe")
  const newEngine = path.join(directory, "new-engine.exe")
  const buildID = "22222222-2222-2222-2222-222222222222"
  const retained = path.join(directory, ".versions", buildID)
  await mkdir(retained, { recursive: true })
  const paired = path.join(retained, "miao-engine.exe")
  const compile = Bun.spawn(
    windowsCommand(String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'public class OldEngine { public static void Main(string[] args) { if (args.Length > 0 && args[0] == "--hold") { System.Console.WriteLine("ready"); System.Threading.Thread.Sleep(60000); return; } System.Console.WriteLine("{\"name\":\"miao-engine\",\"version\":\"0.3.6\",\"protocol\":2,\"schema\":21,\"routesSchema\":2,\"saved_rules_snapshot\":1}"); } }' -OutputAssembly $env:PAIR_OLD -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class NewEngine { public static void Main(string[] args) { System.Console.WriteLine("{\"name\":\"miao-engine\",\"version\":\"0.3.7\",\"protocol\":2,\"schema\":21,\"routesSchema\":2,\"saved_rules_snapshot\":1}"); } }' -OutputAssembly $env:PAIR_NEW -OutputType ConsoleApplication
`),
    {
      env: { ...process.env, PAIR_OLD: oldEngine, PAIR_NEW: newEngine },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  assert.equal(await compile.exited, 0, await new Response(compile.stderr).text())
  const entry = path.join(directory, "entry.ts")
  await Bun.write(
    entry,
    `import { ensureEmbeddedEngine } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/engine/embedded.ts"))};
import { resolveEngine } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/engine/discovery.ts"))};
await ensureEmbeddedEngine();
const selected = resolveEngine();
console.log(JSON.stringify({binary:selected?.binary,version:selected?.capabilities.version}));`,
  )
  const built = await Bun.build({
    entrypoints: [entry, "miao-engine.gen.ts"],
    files: {
      "miao-engine.gen.ts": `import engine from ${JSON.stringify(newEngine)} with { type: "file" }; export default engine;`,
    },
    compile: { outfile: executable, target: "bun-windows-x64-baseline" },
    define: { MIAO_BUILD_ID: JSON.stringify(buildID) },
    splitting: true,
    minify: true,
    plugins: [
      {
        name: "fixture-core",
        setup(build) {
          build.onResolve({ filter: /^@miao\/core\/installation\/executable$/ }, () => ({
            path: path.resolve(import.meta.dir, "../../../core/src/installation/executable.ts"),
          }))
        },
      },
    ],
  })
  assert.equal(built.success, true, built.logs.map(String).join("\n"))
  await link(executable, path.join(retained, "miao.exe"))
  const previous = await readFile(oldEngine)
  const hold = Bun.spawn([oldEngine, "--hold"], { stdout: "pipe", stderr: "pipe" })
  const reader = hold.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  const run = async (override = "") => {
    const child = Bun.spawn([executable], {
      env: { ...process.env, HOME: directory, USERPROFILE: directory, MIAO_ENGINE_BIN: override },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    assert.equal(code, 0, stderr)
    return JSON.parse(stdout) as { binary: string; version: string }
  }
  try {
    assert.equal((await run(oldEngine)).version, "0.3.6", "an explicit operator override remains authoritative")
    const actual = await run()
    assert.equal(path.win32.normalize(actual.binary).toLowerCase(), path.win32.normalize(paired).toLowerCase())
    assert.equal(actual.version, "0.3.7")
    assert.equal(hold.exitCode, null, "the old engine stays running")
    assert.deepEqual(await readFile(oldEngine), previous, "the unmarked old engine is untouched")
    const before = (await stat(paired)).mtimeMs
    assert.equal((await run()).version, "0.3.7")
    assert.equal((await stat(paired)).mtimeMs, before, "a repeated launch reuses its paired engine")
  } finally {
    hold.kill()
    await hold.exited
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 })
  }
}
