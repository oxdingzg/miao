import { describe, expect, test } from "bun:test"
import { ConfigSandbox } from "@miao/core/config/sandbox"
import { SandboxPolicy } from "@miao/core/sandbox/policy"
import { SandboxRunner } from "@miao/core/sandbox/runner"

const info = (input: ConstructorParameters<typeof ConfigSandbox.Info>[0]) => new ConfigSandbox.Info(input)

describe("SandboxPolicy.args", () => {
  test("orders workdirs, allow paths, network, report, then the command", () => {
    expect(
      SandboxPolicy.args(
        { command: ["/bin/sh", "-c", "echo hi"], workdirs: ["/w1", "/w2"], allowNetwork: true },
        ["/extra"],
        "/tmp/report.json",
      ),
    ).toEqual([
      "--workdir",
      "/w1",
      "--workdir",
      "/w2",
      "--allow-path",
      "/extra",
      "--allow-network",
      "--deny-report",
      "/tmp/report.json",
      "--",
      "/bin/sh",
      "-c",
      "echo hi",
    ])
  })

  test("round-trips through the runner argument parser", () => {
    const argv = SandboxPolicy.args({ command: ["ls", "-la"], workdirs: ["/w"], compat: true }, ["/a"], "/r.json")
    expect(SandboxRunner.parseArgs(argv)).toEqual({
      workdirs: ["/w"],
      allowPaths: ["/a"],
      allowNetwork: false,
      compat: true,
      denyReport: "/r.json",
      printProfile: false,
      command: ["ls", "-la"],
    })
    expect(SandboxRunner.parseArgs(["--workdir"])).toEqual({ error: "--workdir requires a path" })
    expect(SandboxRunner.parseArgs(["--bogus"])).toEqual({ error: "unknown argument: --bogus" })
    expect(SandboxRunner.parseArgs([])).toEqual({ error: "no command given; use `-- <command> [args...]`" })
  })
})

describe("SandboxPolicy denial parsing", () => {
  test("extracts the blocked path from macOS and Linux shell errors", () => {
    expect(SandboxPolicy.parseDeniedLine("sh: /Users/me/cache/f.txt: Operation not permitted")).toBe(
      "/Users/me/cache/f.txt",
    )
    expect(SandboxPolicy.parseDeniedLine("sh: 1: cannot create /home/me/cache/f.txt: Permission denied")).toBe(
      "/home/me/cache/f.txt",
    )
    expect(SandboxPolicy.parseDeniedLine("curl: (6) Could not resolve host")).toBeUndefined()
    // An absolute shell path in the prefix is not the blocked path.
    expect(SandboxPolicy.parseDeniedLine("/bin/sh: /Users/me/.cache/x: Operation not permitted")).toBe(
      "/Users/me/.cache/x",
    )
    expect(SandboxPolicy.parseDeniedLine("touch: cannot touch '/home/me/f.txt': Permission denied")).toBe(
      "/home/me/f.txt",
    )
    expect(SandboxPolicy.parseDeniedLine("PermissionError: [Errno 1] Operation not permitted")).toBeUndefined()
  })

  test("reports denial lines that name no path", () => {
    const output = [
      "sh: /Users/me/f.txt: Operation not permitted",
      "connect: Operation not permitted",
      "curl: (7) Failed to connect to 127.0.0.1 port 80 after 0 ms: Couldn't connect to server",
      "everything else is fine",
    ].join("\n")
    expect(SandboxPolicy.unmappedDenials(output, { network: true })).toEqual(["connect: Operation not permitted"])
    // Client network errors only count when the sandbox denies the network.
    expect(SandboxPolicy.unmappedDenials(output, { network: false })).toEqual([
      "connect: Operation not permitted",
      "curl: (7) Failed to connect to 127.0.0.1 port 80 after 0 ms: Couldn't connect to server",
    ])
  })

  test("parses deny reports and tolerates malformed ones", () => {
    expect(SandboxPolicy.parseDenyReport(JSON.stringify({ denied: ["/a", "/b"], exitCode: 1 }))).toEqual(["/a", "/b"])
    // Reports from older miao-run binaries keep the shell path prefix.
    expect(SandboxPolicy.parseDenyReport(JSON.stringify({ denied: ["/bin/sh: /Users/me/f.txt", "/a"] }))).toEqual([
      "/Users/me/f.txt",
      "/a",
    ])
    expect(SandboxPolicy.parseDenyReport("")).toEqual([])
    expect(SandboxPolicy.parseDenyReport("{not json")).toEqual([])
    expect(SandboxPolicy.parseDenyReport(JSON.stringify({ denied: "nope" }))).toEqual([])
  })

  test("reads a missing deny report as empty", async () => {
    expect(await SandboxPolicy.readDenyReport("/definitely/missing/report.json")).toEqual([])
  })
})

describe("SandboxPolicy.settings", () => {
  test("is off with network allowed by default", () => {
    expect(SandboxPolicy.settings([], {})).toEqual({
      enabled: false,
      network: true,
      writableRoots: [],
      onUnavailable: "warn",
    })
  })

  test("later config documents override earlier fields and writable roots accumulate", () => {
    expect(
      SandboxPolicy.settings(
        [
          info({ mode: "workspace-write", network: false, writable_roots: ["~/.cache"] }),
          info({ network: true, writable_roots: ["build"], on_unavailable: "fail" }),
        ],
        {},
      ),
    ).toEqual({ enabled: true, network: true, writableRoots: ["~/.cache", "build"], onUnavailable: "fail" })
    expect(SandboxPolicy.settings([info({ mode: "workspace-write" }), info({ mode: "off" })], {}).enabled).toBe(false)
  })

  test("environment overrides config in both directions", () => {
    const on = [info({ mode: "workspace-write", network: true })]
    const off = [info({ mode: "off", network: false })]
    expect(SandboxPolicy.settings(on, { MIAO_SANDBOX: "0" }).enabled).toBe(false)
    expect(SandboxPolicy.settings(off, { MIAO_SANDBOX: "1" }).enabled).toBe(true)
    expect(SandboxPolicy.settings([], { MIAO_SANDBOX: "true" }).enabled).toBe(true)
    expect(SandboxPolicy.settings(on, { MIAO_SANDBOX: "" }).enabled).toBe(true)
    expect(SandboxPolicy.settings(on, { MIAO_SANDBOX_DENY_NETWORK: "1" }).network).toBe(false)
    expect(SandboxPolicy.settings(off, { MIAO_SANDBOX_DENY_NETWORK: "0" }).network).toBe(true)
  })
})
