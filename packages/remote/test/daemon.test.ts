// Starting and stopping the daemon builds the exact launchctl and process
// commands; every side effect goes through a recording fake, so no launchctl
// runs, no process starts, and nothing is written outside the fake.
import { expect, test } from "bun:test"
import { createDaemonControl, type DaemonSystem } from "../src/daemon"
import { Label } from "../src/launchd"

function fake(input: { loaded?: boolean; bootstrap?: number } = {}) {
  const calls: Array<{ readonly name: string; readonly args: ReadonlyArray<unknown> }> = []
  const system: DaemonSystem = {
    exec: async (argv) => {
      calls.push({ name: "exec", args: argv })
      if (argv[1] === "print") return { code: input.loaded ? 0 : 113, output: "" }
      if (argv[1] === "bootstrap" && input.bootstrap) return { code: input.bootstrap, output: "Bootstrap failed: 5\n" }
      return { code: 0, output: "" }
    },
    spawn: async (argv, log) => {
      calls.push({ name: "spawn", args: [argv, log] })
      return 4242
    },
    kill: (pid, signal) => void calls.push({ name: "kill", args: [pid, signal] }),
    write: async (file, text) => void calls.push({ name: "write", args: [file, text] }),
  }
  return { system, calls }
}

const options = (system: DaemonSystem, platform = "darwin") => ({
  program: ["/Applications/miao app/bin/miao", "remote"],
  platform,
  uid: 501,
  home: "/Users/me",
  agents: "/Users/me/Library/LaunchAgents",
  log: "/Users/me/.local/share/miao/log/remote.log",
  environment: { PATH: "/usr/bin:/bin", HOME: "/Users/me" },
  system,
})

const plist = `/Users/me/Library/LaunchAgents/${Label}.plist`

test("launchd start writes the plist and bootstraps it; the plan shows the same command first", async () => {
  const machine = fake()
  const daemon = createDaemonControl(options(machine.system))
  const plan = await daemon.startPlan("launchd")
  expect(plan).toEqual({ mode: "launchd", commands: [`# 写入 ${plist}`, `launchctl bootstrap gui/501 ${plist}`] })
  // Planning only asks launchctl whether the agent is loaded.
  expect(machine.calls).toEqual([{ name: "exec", args: ["launchctl", "print", `gui/501/${Label}`] }])

  expect(await daemon.start("launchd")).toEqual({ ok: true, log: options(machine.system).log })
  const write = machine.calls.find((call) => call.name === "write")
  expect(write?.args[0]).toBe(plist)
  expect(String(write?.args[1])).toContain("<string>/Applications/miao app/bin/miao</string>")
  expect(String(write?.args[1])).toContain("<key>SuccessfulExit</key>")
  expect(machine.calls.at(-1)).toEqual({ name: "exec", args: ["launchctl", "bootstrap", "gui/501", plist] })
})

test("an agent launchd already loaded is restarted with kickstart -k", async () => {
  const machine = fake({ loaded: true })
  const daemon = createDaemonControl(options(machine.system))
  expect((await daemon.startPlan("launchd")).commands.at(-1)).toBe(`launchctl kickstart -k gui/501/${Label}`)
  await daemon.start("launchd")
  expect(machine.calls.at(-1)).toEqual({ name: "exec", args: ["launchctl", "kickstart", "-k", `gui/501/${Label}`] })
})

test("a failing launchctl reports its exit code and output", async () => {
  const machine = fake({ bootstrap: 5 })
  const result = await createDaemonControl(options(machine.system)).start("launchd")
  expect(result).toEqual({ ok: false, error: `launchctl bootstrap gui/501 ${plist} 退出码 5：Bootstrap failed: 5` })
})

test("detached start spawns the daemon with its log; launchd is refused off macOS", async () => {
  const machine = fake()
  const daemon = createDaemonControl(options(machine.system, "linux"))
  expect(daemon.launchd).toBe(false)
  expect(await daemon.startPlan("detached")).toEqual({
    mode: "detached",
    commands: [`'/Applications/miao app/bin/miao' remote >> /Users/me/.local/share/miao/log/remote.log 2>&1 &`],
  })
  expect(await daemon.start("detached")).toEqual({ ok: true, log: "/Users/me/.local/share/miao/log/remote.log" })
  expect(machine.calls).toEqual([
    {
      name: "spawn",
      args: [["/Applications/miao app/bin/miao", "remote"], "/Users/me/.local/share/miao/log/remote.log"],
    },
  ])
  expect(await daemon.start("launchd")).toEqual({ ok: false, error: "launchd 只在 macOS 上可用" })
  // Off macOS launchctl is never consulted.
  expect(machine.calls.some((call) => call.name === "exec")).toBe(false)
})

test("stop boots out a launchd agent, and signals any other daemon by its pid", async () => {
  const loaded = fake({ loaded: true })
  const launchd = createDaemonControl(options(loaded.system))
  expect(await launchd.stopPlan(42)).toEqual({ mode: "launchd", commands: [`launchctl bootout gui/501/${Label}`] })
  expect((await launchd.stop(42)).ok).toBe(true)
  expect(loaded.calls.at(-1)).toEqual({ name: "exec", args: ["launchctl", "bootout", `gui/501/${Label}`] })
  expect(loaded.calls.some((call) => call.name === "kill")).toBe(false)

  const detached = fake()
  const daemon = createDaemonControl(options(detached.system))
  expect(await daemon.stopPlan(42)).toEqual({ mode: "detached", commands: ["kill -TERM 42"] })
  expect((await daemon.stop(42)).ok).toBe(true)
  expect(detached.calls.at(-1)).toEqual({ name: "kill", args: [42, "SIGTERM"] })
})
