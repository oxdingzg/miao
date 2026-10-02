// Starting and stopping the `miao remote` daemon on behalf of an interface such
// as the TUI. Every side effect (launchctl, spawning, signals, writing the
// plist) goes through injected functions, so callers show the exact commands
// before running them and tests never touch launchd or start a real process.
import path from "node:path"
import { Label, plist } from "./launchd"

export type DaemonMode = "launchd" | "detached"

export type DaemonPlan = {
  readonly mode: DaemonMode
  /** Shell-ready commands this action runs, for the confirmation prompt and the manual fallback. */
  readonly commands: ReadonlyArray<string>
}

export type DaemonResult = { readonly ok: true; readonly log: string } | { readonly ok: false; readonly error: string }

export type DaemonSystem = {
  /** Runs a command to completion; used only for launchctl. */
  readonly exec: (argv: ReadonlyArray<string>) => Promise<{ readonly code: number; readonly output: string }>
  /** Starts a detached process with stdout and stderr appended to `log`; returns its pid. */
  readonly spawn: (argv: ReadonlyArray<string>, log: string) => Promise<number>
  readonly kill: (pid: number, signal: "SIGTERM") => void
  readonly write: (file: string, text: string) => Promise<void>
}

export type DaemonOptions = {
  /** The command that runs the daemon, such as [miao, "remote"]. */
  readonly program: ReadonlyArray<string>
  readonly platform: string
  readonly uid: number
  readonly home: string
  /** ~/Library/LaunchAgents */
  readonly agents: string
  readonly log: string
  readonly environment: Readonly<Record<string, string>>
  readonly system: DaemonSystem
}

export function createDaemonControl(options: DaemonOptions) {
  const file = path.join(options.agents, `${Label}.plist`)
  const domain = `gui/${options.uid}`
  const service = `${domain}/${Label}`
  const launchd = options.platform === "darwin"

  return {
    /** launchd is offered only on macOS; elsewhere the daemon runs detached. */
    launchd,
    plist: file,
    log: options.log,
    startPlan,
    start,
    stopPlan,
    stop,
  }

  async function loaded() {
    if (!launchd) return false
    return (await options.system.exec(["launchctl", "print", service])).code === 0
  }

  async function startPlan(mode: DaemonMode): Promise<DaemonPlan> {
    if (mode === "detached")
      return { mode, commands: [`${options.program.map(quote).join(" ")} >> ${quote(options.log)} 2>&1 &`] }
    const commands = (await loaded())
      ? [`launchctl kickstart -k ${service}`]
      : [`launchctl bootstrap ${domain} ${quote(file)}`]
    return { mode, commands: [`# 写入 ${file}`, ...commands] }
  }

  async function start(mode: DaemonMode): Promise<DaemonResult> {
    if (mode === "detached")
      return options.system.spawn(options.program, options.log).then(
        (): DaemonResult => ({ ok: true, log: options.log }),
        (error: unknown): DaemonResult => ({ ok: false, error: errorText(error) }),
      )
    if (!launchd) return { ok: false, error: "launchd 只在 macOS 上可用" }
    await options.system.write(
      file,
      plist({
        program: options.program,
        workingDirectory: options.home,
        logFile: options.log,
        environment: options.environment,
      }),
    )
    const argv = (await loaded()) ? ["launchctl", "kickstart", "-k", service] : ["launchctl", "bootstrap", domain, file]
    const result = await options.system.exec(argv)
    if (result.code === 0) return { ok: true, log: options.log }
    return {
      ok: false,
      error: `${argv.join(" ")} 退出码 ${result.code}${result.output ? `：${result.output.trim()}` : ""}`,
    }
  }

  /** A daemon launchd loaded is booted out (or KeepAlive would bring it back); any other one gets SIGTERM. */
  async function stopPlan(pid: number): Promise<DaemonPlan> {
    if (await loaded()) return { mode: "launchd", commands: [`launchctl bootout ${service}`] }
    return { mode: "detached", commands: [`kill -TERM ${pid}`] }
  }

  async function stop(pid: number): Promise<DaemonResult> {
    const plan = await stopPlan(pid)
    if (plan.mode === "detached")
      return Promise.resolve()
        .then(() => options.system.kill(pid, "SIGTERM"))
        .then(
          (): DaemonResult => ({ ok: true, log: options.log }),
          (error: unknown): DaemonResult => ({ ok: false, error: errorText(error) }),
        )
    const result = await options.system.exec(["launchctl", "bootout", service])
    if (result.code === 0) return { ok: true, log: options.log }
    return {
      ok: false,
      error: `launchctl bootout 退出码 ${result.code}${result.output ? `：${result.output.trim()}` : ""}`,
    }
  }
}

export type DaemonControl = ReturnType<typeof createDaemonControl>

/** The real launchctl, process spawning, signals, and files. */
export const system: DaemonSystem = {
  exec: async (argv) => {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, output: stderr || stdout }
  },
  spawn: async (argv, log) => {
    const { spawn } = await import("node:child_process")
    const { mkdir, open } = await import("node:fs/promises")
    await mkdir(path.dirname(log), { recursive: true })
    const handle = await open(log, "a", 0o600)
    // A new session survives the interface that started it; the log takes both streams.
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
      cwd: process.env.HOME,
      env: process.env,
    })
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("spawn", () => resolve(child.pid ?? 0))
      child.once("error", reject)
    }).finally(() => handle.close())
    child.unref()
    return pid
  },
  kill: (pid, signal) => void process.kill(pid, signal),
  write: async (file, text) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, text)
  },
}

function quote(value: string) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
