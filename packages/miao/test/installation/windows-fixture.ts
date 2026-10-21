import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { windowsCommand, windowsUpgrade } from "../../src/installation/windows"
import { isDirectInstall } from "../../src/installation/method"

export async function verifyWindowsUpgrade(filename = "miao.exe") {
  const directory = await mkdtemp(path.join(tmpdir(), "miao-upgrade-"))
  const installation = path.join(directory, "安装 with spaces", "Programs", "Miao")
  await mkdir(installation, { recursive: true })
  // A stage a crashed or blocked run left behind must be swept by the next run.
  await mkdir(path.join(installation, ".miao-upgrade-stale"), { recursive: true })
  const executable = path.join(installation, filename)
  assert.equal(isDirectInstall(executable), true)
  const launcher = filename === "miao-bin.exe" ? path.join(installation, "miao.exe") : undefined
  if (launcher) await Bun.write(launcher, "installer launcher")
  const archive = path.join(directory, "release.zip")
  const archiveOld = path.join(directory, "release-old.zip")
  const fixture = await Bun.spawn(
    windowsCommand(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'public class Program { public static void Main(string[] args) { if (args.Length > 0 && args[0] == "--build-id") { System.Console.WriteLine("11111111-1111-1111-1111-111111111111"); return; } System.Console.WriteLine("1.2.2"); if (args.Length > 0 && args[0] != "--version") System.Threading.Thread.Sleep(60000); } }' -OutputAssembly $env:FIXTURE_OLD -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class Candidate { public static void Main(string[] args) { System.Console.WriteLine(args.Length > 0 && args[0] == "--build-id" ? "22222222-2222-2222-2222-222222222222" : "1.2.3"); } }' -OutputAssembly $env:FIXTURE_NEW -OutputType ConsoleApplication
Copy-Item -LiteralPath $env:FIXTURE_OLD -Destination $env:FIXTURE_OLD_COPY
Compress-Archive -LiteralPath $env:FIXTURE_NEW -DestinationPath $env:FIXTURE_ZIP
Compress-Archive -LiteralPath $env:FIXTURE_OLD_COPY -DestinationPath $env:FIXTURE_OLD_ZIP
`),
    {
      env: {
        ...process.env,
        FIXTURE_OLD: executable,
        FIXTURE_OLD_COPY: path.join(directory, "miao-old-copy.exe"),
        FIXTURE_NEW: path.join(directory, "miao.exe"),
        FIXTURE_ZIP: archive,
        FIXTURE_OLD_ZIP: path.join(directory, "release-old.zip"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  assert.equal(await fixture.exited, 0, await new Response(fixture.stderr).text())
  assert.ok((await Bun.file(archive).size) > 1000, "the new archive is not a usable zip")
  assert.ok((await Bun.file(archiveOld).size) > 1000, "the old archive is not a usable zip")
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (request.url.includes("v1.2.6/")) return new Response("missing", { status: 404 })
      if (request.url.includes("v1.2.2/")) return new Response(Bun.file(archiveOld))
      return new Response(request.url.includes("v1.2.5/") ? "invalid zip" : Bun.file(archive))
    },
  })
  const script = windowsUpgrade.replace("https://github.com/oxdingzg/miao/releases/download/v", `${server.url}v`)
  const upgrade = async (version: string) => {
    const child = Bun.spawn(windowsCommand(script), {
      env: {
        ...process.env,
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        MIAO_UPGRADE_VERSION: version,
        MIAO_UPGRADE_EXECUTABLE: executable,
        MIAO_UPGRADE_ARCH: "x64",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: await child.exited, stderr: await new Response(child.stderr).text() }
  }
  const original = await Bun.file(executable).arrayBuffer()
  const old = Bun.spawn([executable, "--hold"], { stdout: "pipe" })
  await old.stdout.getReader().read()
  try {
    const first = await upgrade("1.2.3")
    assert.deepEqual(first, { code: 0, stderr: "" }, `served: ${requests.join(", ")}`)
    assert.equal(
      (await readdir(installation)).some((name) => name.startsWith(".miao-upgrade-")),
      false,
      "the leftover stage directory is swept",
    )
    assert.equal(old.exitCode, null, "the original process must still be running")
    const current = await Bun.file(executable).arrayBuffer()
    assert.equal((await readdir(installation)).filter((name) => name.startsWith(`${filename}.bak-`)).length, 1)
    if (launcher) assert.equal(await Bun.file(launcher).text(), "installer launcher")

    const mismatch = await upgrade("1.2.4")
    assert.equal(mismatch.code, 1)
    assert.match(mismatch.stderr, /failed during verify/)
    assert.deepEqual(await Bun.file(executable).arrayBuffer(), current)
    const missing = await upgrade("1.2.6")
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /failed during download/)
    assert.deepEqual(await Bun.file(executable).arrayBuffer(), current)
    const invalid = await upgrade("invalid/version")
    assert.equal(invalid.code, 1)
    assert.match(invalid.stderr, /failed during prepare/)
    assert.deepEqual(await Bun.file(executable).arrayBuffer(), current)

    const corrupt = await upgrade("1.2.5")
    assert.equal(corrupt.code, 1)
    assert.match(corrupt.stderr, /failed during extract/)
    assert.deepEqual(await Bun.file(executable).arrayBuffer(), current)
    assert.equal((await readdir(installation)).filter((name) => name.startsWith(".miao-upgrade-")).length, 0)
    // Rollback is the documented reinstall of the previous version: the same
    // script targets the old release, the swap keeps the running process
    // alive, and the backup stack gains the upgraded bytes for a redo.
    const rollback = await upgrade("1.2.2")
    assert.equal(rollback.code, 0, `${rollback.stderr} — served: ${requests.join(", ")}`)
    assert.equal(await Bun.file(executable).arrayBuffer(), original, "rollback restores the previous bytes")
    assert.equal(old.exitCode, null, "the original process must survive the rollback swap")
    assert.equal((await readdir(installation)).filter((name) => name.startsWith(`${filename}.bak-`)).length, 2)
    const redownloaded = await upgrade("1.2.3")
    assert.equal(redownloaded.code, 0, `${redownloaded.stderr} — served: ${requests.join(", ")}`)
    assert.deepEqual(await Bun.file(executable).arrayBuffer(), current, "redo restores the upgraded bytes")

    assert.match(requests[0], /^\/v1\.2\.3\/miao-windows-x64(?:-baseline)?\.zip bytes=/)
        assert.deepEqual(
          requests.map((request) => request.split(" ")[0]),
          [
            "/v1.2.3/miao-windows-x64.zip",
            "/v1.2.4/miao-windows-x64.zip",
            "/v1.2.6/miao-windows-x64.zip",
            "/v1.2.5/miao-windows-x64.zip",
            "/v1.2.2/miao-windows-x64.zip",
            "/v1.2.3/miao-windows-x64.zip",
          ].map((path) => path.replace("miao-windows-x64.zip", requests[0].split(" ")[0].split("/").at(-1)!)),
        )
        // Every served archive must actually be a zip-sized body: an empty or
        // truncated one would fail the script's extract phase instead.
        for (const request of requests) {
          const size = Number(request.split("bytes=")[1] ?? 0)
          if (request.includes("v1.2.5/")) continue
          assert.ok(size > 1000, `served archive too small: ${request}`)
        }
  } finally {
    old.kill()
    await old.exited
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
