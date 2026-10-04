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
  const executable = path.join(installation, filename)
  assert.equal(isDirectInstall(executable), true)
  const launcher = filename === "miao-bin.exe" ? path.join(installation, "miao.exe") : undefined
  if (launcher) await Bun.write(launcher, "installer launcher")
  const archive = path.join(directory, "release.zip")
  const fixture = await Bun.spawn(
    windowsCommand(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'public class Program { public static void Main(string[] args) { System.Console.WriteLine("1.2.2"); if (args.Length > 0) System.Threading.Thread.Sleep(60000); } }' -OutputAssembly $env:FIXTURE_OLD -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class Candidate { public static void Main() { System.Console.WriteLine("1.2.3"); } }' -OutputAssembly $env:FIXTURE_NEW -OutputType ConsoleApplication
Compress-Archive -LiteralPath $env:FIXTURE_NEW -DestinationPath $env:FIXTURE_ZIP
`),
    {
      env: {
        ...process.env,
        FIXTURE_OLD: executable,
        FIXTURE_NEW: path.join(directory, "miao.exe"),
        FIXTURE_ZIP: archive,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  assert.equal(await fixture.exited, 0, await new Response(fixture.stderr).text())
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (request.url.includes("v1.2.6/")) return new Response("missing", { status: 404 })
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
  const old = Bun.spawn([executable, "--hold"], { stdout: "pipe" })
  await old.stdout.getReader().read()
  try {
    assert.deepEqual(await upgrade("1.2.3"), { code: 0, stderr: "" })
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
    assert.match(requests[0], /^\/v1\.2\.3\/miao-windows-x64(?:-baseline)?\.zip$/)
    const asset = requests[0].split("/").at(-1)
    assert.deepEqual(requests, [`/v1.2.3/${asset}`, `/v1.2.4/${asset}`, `/v1.2.6/${asset}`, `/v1.2.5/${asset}`])
  } finally {
    old.kill()
    await old.exited
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
