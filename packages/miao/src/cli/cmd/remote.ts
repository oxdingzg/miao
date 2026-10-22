import type { Argv } from "yargs"
import { createHash } from "node:crypto"
import os from "node:os"
import * as prompts from "@clack/prompts"
import { OpenCode } from "@miao/client"
import { DatabaseFile } from "@miao/core/database/file"
import { RuntimeOwnership } from "@miao/core/runtime/ownership"
import { RuntimeRegistration } from "@miao/core/runtime/registration"
import type { RemoteAccess } from "@miao/schema/remote-access"
import { HubSetup } from "@miao/remote-control/hub-setup"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { errorMessage } from "../../util/error"

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

type Client = ReturnType<typeof OpenCode.make>

type Runtime = {
  get: () => Promise<RemoteAccess.Status>
  configure: (configuration: RemoteAccess.Configuration) => Promise<RemoteAccess.Status>
}

type Live = { record: RuntimeRegistration.Record; api: Client["server.runtime"]; runtime: Runtime }

type Binding = { hubURL: string; allowLoopbackHTTP?: boolean }

export const RemoteCommand = cmd({
  command: "remote",
  aliases: ["remote-control"],
  describe: "manage remote access and the Hub account for this machine",
  builder: (yargs) =>
    yargs.command(RemoteLoginCommand).command(RemoteStatusCommand).command(RemoteLogoutCommand).demandCommand(),
  async handler() {},
})

const RemoteLoginCommand = cmd({
  command: "login [url]",
  describe: "sign in to a Hub account and attach this machine to it",
  builder: (yargs: Argv) =>
    yargs
      .positional("url", { describe: "Hub URL, for example https://hub.example.com", type: "string" })
      .option("email", { describe: "account email for password sign-in", type: "string" })
      .option("password", { describe: "account password for password sign-in", type: "string" })
      .option("name", { describe: "label for this machine in the Hub device directory", type: "string" })
      .option("provider", { describe: "sign in with this OAuth provider instead of a password", type: "string" }),
  async handler(args) {
    UI.empty()
    const live = await pickRuntime(await liveRuntimes())
    if (!live) return
    const input = args.url ?? (await askText("Hub URL"))
    if (!input) return
    const binding = parseHubURL(input)
    if (!binding) {
      UI.error("Invalid Hub URL. Use https, or http on localhost.")
      return
    }
    const discovered = await HubSetup.providers(binding).catch(() => undefined)
    const method = await pickMethod(args.provider, discovered?.providers ?? [])
    if (!method) return
    const name = args.name ?? os.hostname()
    prompts.log.step(`Signing in to ${binding.hubURL}`)
    const status = await (method === "password"
      ? passwordSignIn(live, binding, args, name)
      : oauthSignIn(live, binding, method, name))
    if (!status) return
    if (status.enabled && status.connected) {
      prompts.outro(
        `Signed in. Account ${status.accountID ?? "unknown"} on ${status.hubURL ?? binding.hubURL} can reach this machine.`,
      )
      return
    }
    prompts.outro(
      `Attached to ${binding.hubURL}, but Remote Control is not connected. Run miao remote status for details.`,
    )
  },
})

const RemoteStatusCommand = cmd({
  command: "status",
  describe: "show Remote Control and Hub account status",
  async handler() {
    UI.empty()
    const runtimes = await liveRuntimes()
    if (runtimes.length === 0) {
      UI.error("No running miao runtime found. Start miao, then run this command again.")
      return
    }
    for (const runtime of runtimes) {
      const status = await runtime.api.get().catch(() => undefined)
      if (!status) {
        UI.warn(`Runtime ${runtime.record.runtimeID} became unreachable`)
        continue
      }
      UI.println(`${UI.Style.TEXT_NORMAL_BOLD}${runtime.record.runtimeID}${UI.Style.TEXT_NORMAL}`)
      reportLine("enabled", String(status.enabled))
      reportLine("connected", String(status.connected))
      reportLine("hub", status.hubURL)
      reportLine("account", status.accountID)
      reportLine("host", status.hostID)
    }
  },
})

const RemoteLogoutCommand = cmd({
  command: "logout",
  describe: "disable Remote Control for this machine",
  async handler() {
    UI.empty()
    const live = await pickRuntime(await liveRuntimes())
    if (!live) return
    const confirm = await prompts.confirm({ message: `Disable Remote Control on ${live.record.runtimeID}?` })
    if (!confirm || prompts.isCancel(confirm)) return
    const status = await live.api.setEnabled({ enabled: false }).catch(() => undefined)
    if (!status) {
      UI.error("Could not disable Remote Control; the runtime may have shut down.")
      return
    }
    prompts.outro(
      "Remote Control is off. The Hub account stays attached; revoke this machine from the Hub to remove its access.",
    )
  },
})

export function parseHubURL(input: string): Binding | undefined {
  const candidate = input.includes("://") ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return undefined
  return { hubURL: url.origin, allowLoopbackHTTP: loopback || undefined }
}

async function liveRuntimes(): Promise<Live[]> {
  const storage = await RuntimeOwnership.canonicalStorage(DatabaseFile.path())
  const storageID = createHash("sha256").update(storage).digest("hex")
  const records = await RuntimeRegistration.list(storage)
  const candidates = await Promise.all(
    records.map(async (record) => {
      const attested = await RuntimeRegistration.attest(record, { version: record.version, storageID }).catch(
        () => undefined,
      )
      if (!attested) return undefined
      const api = runtimeAPI(attested)
      return { record: attested, api, runtime: runtimeScope(api) }
    }),
  )
  return candidates.filter((value): value is Live => value !== undefined)
}

function runtimeAPI(record: RuntimeRegistration.Record) {
  return OpenCode.make({
    baseUrl: record.url,
    // The discovery credential only authenticates this local attachment and
    // must never follow a redirect to another origin.
    headers: { authorization: `Basic ${Buffer.from(`miao:${record.credential}`).toString("base64")}` },
    fetch: Object.assign(
      (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
      { preconnect: fetch.preconnect },
    ),
  })["server.runtime"]
}

function runtimeScope(api: Client["server.runtime"]): Runtime {
  return {
    get: () => api.get(),
    configure: (configuration) => api.configure(configuration),
  }
}

async function pickRuntime(runtimes: Live[]): Promise<Live | undefined> {
  if (runtimes.length === 0) {
    UI.error("No running miao runtime found. Start miao, then run this command again.")
    return undefined
  }
  if (runtimes.length === 1) return runtimes[0]
  const choice = await prompts.select({
    message: "Which running runtime?",
    options: runtimes.map((runtime) => ({
      value: runtime,
      label: `${runtime.record.runtimeID} · ${runtime.record.url}`,
    })),
  })
  if (prompts.isCancel(choice)) return undefined
  return choice
}

async function pickMethod(provider: string | undefined, providers: ReadonlyArray<string>): Promise<string | undefined> {
  if (provider) return provider
  if (providers.length === 0) return "password"
  const choice = await prompts.select({
    message: "Sign in with",
    options: [
      { value: "password", label: "Email and password" },
      ...providers.map((id) => ({ value: id, label: id })),
    ],
  })
  if (prompts.isCancel(choice)) return undefined
  return choice
}

async function passwordSignIn(
  live: Live,
  binding: Binding,
  args: { email?: string; password?: string },
  name: string,
): Promise<RemoteAccess.Status | undefined> {
  const email = args.email ?? (await askText("Account email"))
  if (!email) return undefined
  const password = args.password ?? (await askSecret("Password"))
  if (!password) return undefined
  try {
    return await HubSetup.connect({ ...binding, email, password, name, runtime: live.runtime })
  } catch (error) {
    UI.error(errorMessage(error))
    return undefined
  }
}

async function oauthSignIn(
  live: Live,
  binding: Binding,
  provider: string,
  name: string,
): Promise<RemoteAccess.Status | undefined> {
  const listener = codeListener()
  try {
    return await HubSetup.connectWithOAuth({
      ...binding,
      provider,
      name,
      runtime: live.runtime,
      callbackURL: listener.callbackURL,
      open: async (authorizeURL) => {
        prompts.log.info(`Authorize in your browser (${authorizeURL})`)
        await openBrowser(authorizeURL)
      },
      waitForCode: listener.waitForCode,
    })
  } catch (error) {
    UI.error(errorMessage(error))
    return undefined
  }
}

function codeListener() {
  const settle = {
    resolve: (_code: string) => {},
    reject: (_error: Error) => {},
  }
  const code = new Promise<string>((resolve, reject) => {
    settle.resolve = resolve
    settle.reject = reject
  })
  const timer = setTimeout(() => settle.reject(new Error("Authorization timed out")), 300_000)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      const value = url.searchParams.get("code")
      const failure = url.searchParams.get("error")
      if (value) settle.resolve(value)
      else settle.reject(new Error(failure ?? "The Hub did not return an authorization code"))
      clearTimeout(timer)
      return new Response("Sign-in complete. You can close this tab and return to the terminal.")
    },
  })
  return {
    callbackURL: `http://127.0.0.1:${server.port}/callback`,
    waitForCode: () => code.finally(() => server.stop(true)),
  }
}

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  return Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited.catch(() => {})
}

async function askText(message: string): Promise<string | undefined> {
  const value = await prompts.text({ message })
  if (prompts.isCancel(value) || value.trim() === "") return undefined
  return value.trim()
}

async function askSecret(message: string): Promise<string | undefined> {
  const value = await prompts.password({ message })
  if (prompts.isCancel(value) || value === "") return undefined
  return value
}

function reportLine(label: string, value: string | undefined) {
  UI.println(`  ${UI.Style.TEXT_DIM}${label}${UI.Style.TEXT_NORMAL} ${value ?? "-"}`)
}

export * as Remote from "./remote"
