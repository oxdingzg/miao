import { chromium } from "@playwright/test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { HubService } from "../src/hub-service"
import { DeviceGrants } from "../src/grants"
import { ControlAgent } from "../src/agent"
import { ControlPairing } from "../src/pairing"

const privateDirectory = await mkdtemp(path.join(os.tmpdir(), "miao-web-check-"))
const grants = await DeviceGrants.load(path.join(privateDirectory, "devices.json"))
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reservation.port
reservation.stop(true)
const origin = `http://127.0.0.1:${port}`
const database = new Database(":memory:")
const hub = await HubService.listen({
  database,
  baseURL: origin,
  secret: "web-ui-fixture-secret-000000000000000000000000",
  allowLoopbackHTTP: true,
  port,
  migrate: true,
  webDirectory: fileURLToPath(new URL("../dist/web/", import.meta.url)),
  bootstrap: { name: "Web fixture", email: "web@example.invalid", password: "web-ui-fixture-password-0001" },
})
const request = (route: string, body?: unknown, token?: string) =>
  fetch(origin + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
let agent: ReturnType<typeof ControlAgent.connect> | undefined
let pairing: ReturnType<typeof ControlPairing.make> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let approveTimer: ReturnType<typeof setInterval> | undefined
let approvals = Promise.resolve()
let prompted = 0
try {
  const login = await request("/api/auth/sign-in/email", {
    email: "web@example.invalid",
    password: "web-ui-fixture-password-0001",
  })
  const loginToken = login.headers.get("set-auth-token")
  if (!loginToken) throw new Error("Fixture login unavailable")
  const access = (await (await request("/api/auth/token", undefined, loginToken)).json()) as { token: string }
  const registered = (await (
    await request(
      "/api/hub/hosts",
      { hostID: grants.hostID, name: "Studio computer", publicKey: grants.identity.publicKey },
      access.token,
    )
  ).json()) as { token: string }
  const target = { hostID: grants.hostID, runtimeID: crypto.randomUUID() }
  pairing = ControlPairing.make({ grants, target, hubURL: origin })
  const events: {
    type: string
    data: { sessionID: string; text?: string; prompt?: { text: string } }
    durable: { seq: number }
  }[] = [
    {
      type: "session.next.prompted",
      data: { sessionID: "session_fixture", prompt: { text: "请整理今天的变更。" } },
      durable: { seq: 1 },
    },
    {
      type: "session.next.text.ended",
      data: { sessionID: "session_fixture", text: "已整理变更，等待你的下一步。" },
      durable: { seq: 2 },
    },
  ]
  agent = ControlAgent.connect({
    hubURL: origin,
    hostToken: registered.token,
    runtimeID: target.runtimeID,
    grants,
    pairing,
    allowLoopbackHTTP: true,
    projectForSession: async () => "project_fixture",
    methods: {
      "session.list": async () => ({
        data: [{ id: "session_fixture", title: "Remote workspace", projectID: "project_fixture" }],
        cursor: { next: null },
      }),
      "session.events": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("after" in request.payload) ||
          typeof request.payload.after !== "number"
        )
          throw new Error("Invalid event request")
        const data = events.filter((event) => event.durable.seq > (request.payload as { after: number }).after)
        if (!data.length) await Bun.sleep(100)
        return { data, cursor: data.at(-1)?.durable.seq ?? request.payload.after }
      },
      "session.prompt": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("text" in request.payload) ||
          typeof request.payload.text !== "string"
        )
          throw new Error("Invalid prompt")
        prompted++
        events.push({
          type: "session.next.prompted",
          data: { sessionID: "session_fixture", prompt: { text: request.payload.text } },
          durable: { seq: events.length + 1 },
        })
        return {
          status: "accepted",
          messageID: "message_fixture",
          sessionID: "session_fixture",
          admittedSeq: events.length,
        }
      },
      "operation.get": async () => ({ status: "accepted", result: {} }),
    },
  })
  const deadline = Date.now() + 10000
  while (!agent.connected() && Date.now() < deadline) await Bun.sleep(20)
  if (!agent.connected()) throw new Error("Agent did not connect")
  const invitation = pairing.issue({
    permissions: ["read", "prompt"],
    projectIDs: ["project_fixture"],
    sessionIDs: [],
    expiresAt: Date.now() + 120000,
  })
  approveTimer = setInterval(() => {
    for (const candidate of pairing!.list())
      approvals = approvals.then(async () => {
        await pairing!.approve(candidate.pairingID, candidate.candidate.publicKey)
      })
  }, 25)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.name))
  await page.goto(origin)
  await page.getByLabel("邮箱").fill("web@example.invalid")
  await page.getByLabel("密码").fill("web-ui-fixture-password-0001")
  await page.getByRole("button", { name: "登录 →" }).click()
  await page.getByRole("button", { name: "Studio computer" }).waitFor()
  await page.getByText("配对新设备", { exact: true }).click()
  await page.getByLabel("配对邀请", { exact: true }).fill(JSON.stringify(invitation))
  await page.getByRole("button", { name: "请求配对" }).click()
  await page.getByText("设备已授权。选择电脑继续。", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Studio computer" }).click()
  await page.getByRole("button", { name: "Remote workspace", exact: true }).click()
  await page.getByText("已整理变更，等待你的下一步。", { exact: false }).waitFor()
  await page.getByLabel("发送到会话").fill("继续检查远程功能。")
  await page.getByRole("button", { name: "发送 ↑" }).click()
  await page.getByText("输入已接收。", { exact: true }).waitFor()
  if (prompted !== 1 || (await page.getByLabel("发送到会话").inputValue()) !== "")
    throw new Error("Prompt admission UI failed")
  await page.getByLabel("发送到会话").fill("尚未发送的草稿")
  await page.waitForTimeout(200)
  await page.reload()
  await page.getByRole("button", { name: "Studio computer" }).click()
  await page.getByRole("button", { name: "Remote workspace", exact: true }).click()
  await page.waitForFunction(() => (document.getElementById("draft") as HTMLTextAreaElement).value === "尚未发送的草稿")
  if (prompted !== 1) throw new Error("Reconnect replayed a prompt")
  if (process.env.MIAO_WEB_SCREENSHOT) await page.screenshot({ path: process.env.MIAO_WEB_SCREENSHOT, fullPage: true })
  await page.getByRole("button", { name: "退出账号", exact: true }).click()
  await page.getByRole("button", { name: "登录 →" }).waitFor()
  if ((await page.locator("#timeline").textContent()) !== "" || errors.length)
    throw new Error("Logout or browser execution failed")
  console.log(
    "Web UI: real Hub/Agent login, pairing, sessions, scoped encrypted prompt, draft restoration and no replay passed",
  )
} finally {
  if (approveTimer) clearInterval(approveTimer)
  await approvals.catch(() => undefined)
  await browser?.close()
  await agent?.stop()
  await pairing?.stop()
  await grants.close()
  hub.stop()
  database.close()
  await rm(privateDirectory, { recursive: true, force: true })
}
