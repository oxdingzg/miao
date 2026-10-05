import { chromium } from "@playwright/test"
import { Database } from "bun:sqlite"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { HubService } from "../src/hub-service"
import { DeviceGrants } from "../src/grants"
import { RuntimeDiscovery } from "../../core/src/runtime/discovery"
import { RuntimeOwnership } from "../../core/src/runtime/ownership"
import { InstallationVersion } from "../../core/src/installation/version"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const directory = await mkdtemp(path.join(os.tmpdir(), "miao-web-runtime-"))
const databasePath = path.join(directory, "sessions.db")
const project = path.join(directory, "project")
const sessionID = "ses_web_" + crypto.randomUUID().replaceAll("-", "")
const projectScope = process.argv.includes("--project-scope")
const grants = await DeviceGrants.load(path.join(directory, "devices.json"))
const hostID = grants.hostID
const hostKey = grants.identity.publicKey
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reservation.port
reservation.stop(true)
const origin = `http://127.0.0.1:${port}`
const database = new Database(":memory:")
const hub = await HubService.listen({
  database,
  baseURL: origin,
  secret: "runtime-web-fixture-secret-0000000000000000000000",
  allowLoopbackHTTP: true,
  port,
  migrate: true,
  webDirectory: fileURLToPath(new URL("../dist/web/", import.meta.url)),
  bootstrap: {
    name: "Runtime fixture",
    email: "runtime@example.invalid",
    password: "runtime-web-fixture-password-0001",
  },
})
let runtime: ReturnType<typeof Bun.spawn> | undefined
let output: Promise<string> | undefined
let errors: Promise<string> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let approval: Promise<void> | undefined
let stopApproval = false
let stage = "setup"
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
try {
  const hubRequest = (route: string, body?: unknown, token?: string) =>
    fetch(origin + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
  const login = await hubRequest("/api/auth/sign-in/email", {
    email: "runtime@example.invalid",
    password: "runtime-web-fixture-password-0001",
  })
  const loginToken = login.headers.get("set-auth-token")
  if (!loginToken) throw new Error("Fixture account unavailable")
  const access: unknown = await (await hubRequest("/api/auth/token", undefined, loginToken)).json()
  if (!object(access) || typeof access.token !== "string") throw new Error("Fixture authorization unavailable")
  const registration: unknown = await (
    await hubRequest("/api/hub/hosts", { hostID, name: "Runtime computer", publicKey: hostKey }, access.token)
  ).json()
  if (!object(registration) || typeof registration.token !== "string") throw new Error("Fixture host unavailable")
  const configuration = path.join(directory, "control.json")
  await Bun.write(
    configuration,
    JSON.stringify({
      hubURL: origin,
      hostToken: registration.token,
      grantFile: "devices.json",
      allowLoopbackHTTP: true,
    }),
  )
  await chmod(configuration, 0o600)
  await grants.close()
  await mkdir(project)
  if ((await Bun.spawn(["git", "init", "--quiet", project]).exited) !== 0)
    throw new Error("Fixture project unavailable")
  if (
    (await Bun.spawn([
      "git",
      "-C",
      project,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "fixture",
    ]).exited) !== 0
  )
    throw new Error("Fixture project unavailable")
  stage = "runtime"
  const started = Bun.spawn([process.execPath, "run", "src/index.ts", "runtime"], {
    cwd: path.join(root, "packages/miao"),
    env: {
      ...process.env,
      MIAO_DB: databasePath,
      MIAO_REMOTE_CONTROL_CONFIG: configuration,
      MIAO_PURE: "1",
      MIAO_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/missing",
        formatter: false,
        lsp: false,
        remote: { projects: {} },
      }),
      MIAO_TEST_HOME: path.join(directory, "home"),
      MIAO_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  runtime = started
  output = new Response(started.stdout).text()
  errors = new Response(started.stderr).text()
  const storageID = createHash("sha256")
    .update(await RuntimeOwnership.canonicalStorage(databasePath))
    .digest("hex")
  let owner: RuntimeDiscovery.Record | undefined
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null) throw new Error("Fixture Runtime exited before readiness")
    const candidate = await RuntimeDiscovery.read(databasePath)
    if (candidate)
      owner = await RuntimeDiscovery.attest(candidate, { version: InstallationVersion, storageID }).catch(
        () => undefined,
      )
    if (owner) break
    await Bun.sleep(100)
  }
  if (!owner) throw new Error("Fixture Runtime readiness timed out")
  const headers = {
    authorization: `Basic ${Buffer.from(`miao:${owner.credential}`).toString("base64")}`,
    "content-type": "application/json",
  }
  const request = async (route: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(route, owner.url), {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error("Fixture owner API rejected request")
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  const created = await request("/api/session", { id: sessionID, location: { directory: project } })
  if (!object(created) || !object(created.data) || typeof created.data.projectID !== "string")
    throw new Error("Fixture project missing")
  await request(`/api/session/${sessionID}/rename`, { title: "Live Runtime workspace" })
  if (projectScope) {
    for (let index = 0; index < 100; index++)
      await request("/api/session", {
        id: "ses_page_" + crypto.randomUUID().replaceAll("-", ""),
        location: { directory: project },
      })
  }
  const invitation = await request("/api/runtime/control/invitation", {
    permissions: ["read", "prompt", "session.rename", "session.selection", ...(projectScope ? ["session.create"] : [])],
    sessionIDs: projectScope ? [] : [sessionID],
    projectIDs: projectScope ? [created.data.projectID] : [],
    expiresAt: Date.now() + 600000,
  })
  if (!object(invitation) || typeof invitation.pairingID !== "string") throw new Error("Fixture invitation unavailable")
  approval = (async () => {
    while (!stopApproval) {
      const candidates = await request("/api/runtime/control/pairing")
      if (!Array.isArray(candidates)) throw new Error("Fixture pairing unavailable")
      const candidate: unknown = candidates.find(
        (candidate: unknown) => object(candidate) && candidate.pairingID === invitation.pairingID,
      )
      if (object(candidate) && object(candidate.candidate) && typeof candidate.candidate.publicKey === "string") {
        await request(`/api/runtime/control/pairing/${invitation.pairingID}/approve`, {
          publicKey: candidate.candidate.publicKey,
        })
        return
      }
      await Bun.sleep(100)
    }
  })()
  void approval.catch(() => browser?.close())
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on("console", (message) => {
    if (
      /^Remote action failed (forbidden|not_found|conflict|expired|outcome_unknown|invalid_request|unavailable|disconnected|timeout|busy|invalid_response)$/.test(
        message.text(),
      )
    )
      console.error(message.text())
  })
  const openListed = async (label: string) => {
    const item = page.getByRole("button", { name: label, exact: true })
    await page.locator("#sessions .item").first().waitFor()
    for (let index = 0; index < 3 && !(await item.count()); index++) {
      const next = page.getByRole("button", { name: "下一页", exact: true })
      if (!(await next.isEnabled())) break
      const first = await page.locator("#sessions .item").first().textContent()
      await next.click()
      await page.waitForFunction((label) => document.querySelector("#sessions .item")?.textContent !== label, first)
    }
    await item.click()
  }
  stage = "login"
  await page.goto(origin)
  await page.getByLabel("邮箱").fill("runtime@example.invalid")
  await page.getByLabel("密码").fill("runtime-web-fixture-password-0001")
  await page.getByRole("button", { name: "登录 →" }).click()
  await page.getByRole("button", { name: "Runtime computer" }).waitFor()
  stage = "pairing"
  await page.getByText("配对新设备", { exact: true }).click()
  await page
    .getByLabel("配对邀请", { exact: true })
    .fill("miao://pair#" + Buffer.from(JSON.stringify(invitation)).toString("base64url"))
  await page.getByRole("button", { name: "请求配对" }).click()
  await page.getByText("设备已授权。选择电脑继续。", { exact: true }).waitFor()
  stage = "session"
  await page.getByRole("button", { name: "Runtime computer" }).click()
  if (projectScope) {
    await page.waitForFunction(() => document.querySelectorAll("#sessions .item").length === 100)
    await page.getByRole("button", { name: "下一页", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#sessions .item").length === 1)
    await page.getByRole("button", { name: "上一页", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll("#sessions .item").length === 100)
  }
  await openListed("Live Runtime workspace")
  stage = "owner-diff"
  const directDiff = await request(`/api/session/${sessionID}/diff`)
  if (!object(directDiff) || !Array.isArray(directDiff.data) || directDiff.data.length)
    throw new Error("Fixture diff shape unexpected")
  stage = "diff"
  await page.getByRole("button", { name: "文件变化", exact: true }).click()
  await page.getByText("当前会话还没有文件变化。", { exact: true }).waitFor()
  await page.getByRole("button", { name: "关闭文件变化", exact: true }).click()
  stage = "admission"
  await page.getByLabel("发送到会话").fill("持久化网页输入")
  await page.getByRole("button", { name: "发送 ↑" }).click()
  await page.getByText("输入已接收。", { exact: true }).waitFor()
  await page.locator("#timeline").getByText("持久化网页输入", { exact: false }).waitFor()
  await page.getByLabel("发送到会话").fill("真实 Runtime 草稿")
  await page.waitForTimeout(200)
  stage = "rename"
  await page.getByRole("button", { name: "重命名", exact: true }).click()
  await page.getByLabel("新名称", { exact: true }).fill("Renamed Runtime workspace")
  await page.getByRole("button", { name: "保存名称", exact: true }).click()
  await page.getByText("会话名称已更新。", { exact: true }).waitFor()
  const renamed = await request(`/api/session/${sessionID}`)
  if (!object(renamed) || !object(renamed.data) || renamed.data.title !== "Renamed Runtime workspace")
    throw new Error("Runtime rename not persisted")
  stage = "agent-selection"
  await page.getByRole("button", { name: "Agent / 模型", exact: true }).click()
  await page.getByLabel("Agent", { exact: true }).selectOption("plan")
  await page.getByRole("button", { name: "保存 Agent", exact: true }).click()
  await page.getByText("Agent 已更新，下次模型调用起生效。", { exact: true }).waitFor()
  const selected = await request(`/api/session/${sessionID}`)
  if (!object(selected) || !object(selected.data) || selected.data.agent !== "plan")
    throw new Error("Runtime agent selection not persisted")
  const before = await request(`/api/session/${sessionID}/history?after=0&limit=100`)
  stage = "recovery"
  await page.reload()
  await page.getByRole("button", { name: "Runtime computer" }).click()
  await openListed("Renamed Runtime workspace")
  await page.waitForFunction(
    () => (document.getElementById("draft") as HTMLTextAreaElement).value === "真实 Runtime 草稿",
  )
  if (projectScope) {
    stage = "creation"
    const beforeList = await request(`/api/session?project=${created.data.projectID}&limit=100`)
    await page.getByRole("button", { name: "新建会话", exact: true }).click()
    await page.waitForFunction(
      () => document.getElementById("session-title")?.textContent !== "Renamed Runtime workspace",
    )
    const list = await request(`/api/session?project=${created.data.projectID}&limit=100`)
    if (
      !object(beforeList) ||
      !Array.isArray(beforeList.data) ||
      !object(list) ||
      !Array.isArray(list.data) ||
      !list.data.some(
        (session: unknown) => object(session) && typeof session.id === "string" && session.id.startsWith("ses_remote_"),
      )
    )
      throw new Error("Runtime creation did not persist")
    await page.reload()
    await page.getByRole("button", { name: "Runtime computer" }).click()
    await page.getByRole("button", { name: "新建会话", exact: true }).waitFor()
    const restoredList = await request(`/api/session?project=${created.data.projectID}&limit=100`)
    if (
      !object(restoredList) ||
      !Array.isArray(restoredList.data) ||
      restoredList.data.filter(
        (session: unknown) => object(session) && typeof session.id === "string" && session.id.startsWith("ses_remote_"),
      ).length !== 1
    )
      throw new Error("Reconnect recreated the session")
  }
  const after = await request(`/api/session/${sessionID}/history?after=0&limit=100`)
  const admissions = (value: unknown) =>
    object(value) && Array.isArray(value.data)
      ? value.data.filter((event: unknown) => object(event) && event.type === "session.next.prompt.admitted").length
      : -1
  if (admissions(before) !== 1 || admissions(after) !== 1) throw new Error("Runtime admission was missing or replayed")
  console.log(
    "Web real Runtime: " +
      (projectScope ? "101 project-scoped sessions and bidirectional pagination" : "session-scoped access") +
      ", durable rename/input/history and no admission replay passed",
  )
} catch {
  throw new Error("Web Runtime verification failed at " + stage)
} finally {
  stopApproval = true
  await browser?.close()
  if (runtime) {
    runtime.kill()
    const deadline = setTimeout(() => runtime?.kill("SIGKILL"), 10000)
    await runtime.exited
    clearTimeout(deadline)
    await Bun.write(path.join(directory, "runtime.log"), ((await output) ?? "") + "\n" + ((await errors) ?? ""))
  }
  await approval?.catch(() => undefined)
  await grants.close()
  hub.stop()
  database.close()
  if (!process.env.MIAO_KEEP_WEB_RUNTIME_FIXTURE) await rm(directory, { recursive: true, force: true })
}
