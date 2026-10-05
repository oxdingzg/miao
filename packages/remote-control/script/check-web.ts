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
let permissionReplied = false
let questionReplied = false
let interrupted = false
let sessionTitle = "Remote workspace"
let stage = "setup"
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
      data: { sessionID: "ses_fixture", prompt: { text: "请整理今天的变更。" } },
      durable: { seq: 1 },
    },
    {
      type: "session.next.text.ended",
      data: { sessionID: "ses_fixture", text: "已整理变更，等待你的下一步。" },
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
        data: [{ id: "ses_fixture", title: sessionTitle, projectID: "project_fixture" }],
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
          data: { sessionID: "ses_fixture", prompt: { text: request.payload.text } },
          durable: { seq: events.length + 1 },
        })
        return {
          status: "accepted",
          messageID: "message_fixture",
          sessionID: "ses_fixture",
          admittedSeq: events.length,
        }
      },
      "session.pending": async () => ({
        permissions: permissionReplied
          ? []
          : [{ id: "per_fixture", sessionID: "ses_fixture", action: "修改文件", resources: ["src/**"] }],
        questions: questionReplied
          ? []
          : [
              {
                id: "que_fixture",
                sessionID: "ses_fixture",
                questions: [
                  {
                    header: "入口",
                    question: "选择接入入口",
                    options: [
                      { label: "使用网页", description: "浏览器操作" },
                      { label: "使用终端", description: "电脑操作" },
                    ],
                  },
                  {
                    header: "设备",
                    question: "选择设备",
                    multiSelect: true,
                    custom: false,
                    options: [
                      { label: "iPhone", description: "手机" },
                      { label: "iPad", description: "平板" },
                    ],
                  },
                ],
              },
            ],
        execution: interrupted ? { type: "idle" } : { type: "running", executionID: "execution_fixture" },
      }),
      "permission.reply": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("reply" in request.payload) ||
          request.payload.reply !== "once"
        )
          throw new Error("Wrong permission choice")
        permissionReplied = true
        return { status: "completed" }
      },
      "question.reply": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("answers" in request.payload) ||
          JSON.stringify(request.payload.answers) !== JSON.stringify([["使用网页"], ["iPhone", "iPad"]])
        )
          throw new Error("Wrong question answers")
        questionReplied = true
        return { status: "completed" }
      },
      "session.rename": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("title" in request.payload) ||
          typeof request.payload.title !== "string"
        )
          throw new Error("Invalid rename")
        sessionTitle = request.payload.title
        return { status: "completed" }
      },
      "session.interrupt": async (request) => {
        if (
          typeof request.payload !== "object" ||
          !request.payload ||
          !("executionID" in request.payload) ||
          request.payload.executionID !== "execution_fixture"
        )
          throw new Error("Interrupt was not fenced")
        interrupted = true
        return { status: "completed" }
      },
      "operation.get": async () => ({ status: "accepted", result: {} }),
    },
  })
  const deadline = Date.now() + 10000
  while (!agent.connected() && Date.now() < deadline) await Bun.sleep(20)
  if (!agent.connected()) throw new Error("Agent did not connect")
  const invitation = pairing.issue({
    permissions: ["read", "prompt", "session.rename", "interrupt", "permission.reply", "question.reply"],
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
  stage = "login"
  await page.goto(origin)
  await page.getByLabel("邮箱").fill("web@example.invalid")
  await page.getByLabel("密码").fill("web-ui-fixture-password-0001")
  await page.getByRole("button", { name: "登录 →" }).click()
  await page.getByRole("button", { name: "Studio computer" }).waitFor()
  stage = "pairing"
  await page.getByText("配对新设备", { exact: true }).click()
  await page.getByLabel("配对邀请", { exact: true }).fill(JSON.stringify(invitation))
  await page.getByRole("button", { name: "请求配对" }).click()
  await page.getByText("设备已授权。选择电脑继续。", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Studio computer" }).click()
  stage = "history"
  await page.getByRole("button", { name: "Remote workspace", exact: true }).click()
  await page.getByText("已整理变更，等待你的下一步。", { exact: false }).waitFor()
  stage = "permission"
  await page.getByLabel("使用网页 · 浏览器操作", { exact: true }).check()
  await page.getByLabel("iPhone · 手机", { exact: true }).check()
  await page.getByRole("button", { name: "允许这一次", exact: true }).click()
  await page.getByRole("button", { name: "允许这一次", exact: true }).waitFor({ state: "hidden" })
  if (
    !(await page.getByLabel("使用网页 · 浏览器操作", { exact: true }).isChecked()) ||
    !(await page.getByLabel("iPhone · 手机", { exact: true }).isChecked())
  )
    throw new Error("Decision refresh discarded question choices")
  stage = "question"
  await page.getByLabel("使用网页 · 浏览器操作", { exact: true }).check()
  await page.getByLabel("iPhone · 手机", { exact: true }).check()
  await page.getByLabel("iPad · 平板", { exact: true }).check()
  await page.getByRole("button", { name: "提交回答", exact: true }).click()
  stage = "interrupt"
  await page.getByRole("button", { name: "停止任务", exact: true }).click()
  await page.getByText("已请求停止当前任务。", { exact: true }).waitFor()
  stage = "rename"
  await page.getByRole("button", { name: "重命名", exact: true }).click()
  await page.getByLabel("新名称", { exact: true }).fill("Renamed browser workspace")
  await page.getByRole("button", { name: "保存名称", exact: true }).click()
  await page.getByText("会话名称已更新。", { exact: true }).waitFor()
  if (!permissionReplied || !questionReplied || !interrupted || sessionTitle !== "Renamed browser workspace")
    throw new Error("Session actions failed")
  stage = "prompt"
  await page.getByLabel("发送到会话").fill("继续检查远程功能。")
  await page.getByRole("button", { name: "发送 ↑" }).click()
  await page.getByText("输入已接收。", { exact: true }).waitFor()
  if (prompted !== 1 || (await page.getByLabel("发送到会话").inputValue()) !== "")
    throw new Error("Prompt admission UI failed")
  await page.getByLabel("发送到会话").fill("尚未发送的草稿")
  await page.waitForTimeout(200)
  stage = "recovery"
  await page.reload()
  await page.getByRole("button", { name: "Studio computer" }).click()
  await page.getByRole("button", { name: "Renamed browser workspace", exact: true }).click()
  await page.waitForFunction(() => (document.getElementById("draft") as HTMLTextAreaElement).value === "尚未发送的草稿")
  if (prompted !== 1) throw new Error("Reconnect replayed a prompt")
  if (process.env.MIAO_WEB_SCREENSHOT) await page.screenshot({ path: process.env.MIAO_WEB_SCREENSHOT, fullPage: true })
  stage = "logout"
  await page.getByRole("button", { name: "退出账号", exact: true }).click()
  await page.getByRole("button", { name: "登录 →" }).waitFor()
  if ((await page.locator("#timeline").textContent()) !== "" || errors.length)
    throw new Error("Logout or browser execution failed")
  console.log(
    "Web UI: real Hub/Agent login, pairing, rename, fenced interrupt, permission/question choices, preserved form state, prompt and draft recovery passed",
  )
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      errorName: error instanceof Error ? error.name : "unknown",
      permissionReplied,
      questionReplied,
      interrupted,
    }),
  )
  throw new Error("Web interface verification failed")
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
