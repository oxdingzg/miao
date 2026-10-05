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
let selectedAgent = ""
let selectedModel: unknown
let prompted = 0
let creationCalls = 0
const creationReceipts = new Map<string, unknown>()
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
      "project.list": async () => ({
        data: [
          {
            id: "project_fixture",
            name: "Browser project",
            directories: [{ id: "a".repeat(64), name: "Fixture folder" }],
          },
        ],
      }),
      "session.list": async (request) => {
        const cursor =
          typeof request.payload === "object" && request.payload && "cursor" in request.payload
            ? request.payload.cursor
            : undefined
        return cursor === "100"
          ? {
              data: [{ id: "ses_fixture", title: sessionTitle, projectID: "project_fixture" }],
              cursor: { next: null },
            }
          : {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: "ses_page_" + index,
                title: "Paged session " + index,
                projectID: "project_fixture",
              })),
              cursor: { next: "100" },
            }
      },
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
      "session.diff": async () => [
        {
          path: "src/remote.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "-old\n+<script>unsafe()</script>",
        },
      ],
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
      "selection.list": async () => ({
        agents: [{ id: "plan" }],
        models: [
          { id: "fixture-model", providerID: "fixture", name: "Fixture model", variants: [{ id: "reasoning" }] },
        ],
      }),
      "session.switchAgent": async (request) => {
        if (JSON.stringify(request.payload) !== JSON.stringify({ agent: "plan" }))
          throw new Error("Invalid agent selection")
        selectedAgent = "plan"
        return { status: "completed" }
      },
      "session.switchModel": async (request) => {
        selectedModel = request.payload
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
      "session.create": async (request) => {
        if (!request.operationID || request.projectID !== "project_fixture") throw new Error("Invalid creation scope")
        creationCalls++
        const result = {
          status: "completed",
          session: { id: "ses_created_fixture", title: "Created fixture", projectID: "project_fixture" },
        }
        creationReceipts.set(request.operationID, {
          status: "completed",
          result,
          sessionID: result.session.id,
          operationID: request.operationID,
        })
        await Bun.sleep(1500)
        return result
      },
      "operation.get": async (request) => {
        const id =
          typeof request.payload === "object" && request.payload && "operationID" in request.payload
            ? request.payload.operationID
            : undefined
        return typeof id === "string" && creationReceipts.has(id)
          ? creationReceipts.get(id)
          : { status: "accepted", result: {} }
      },
    },
  })
  const deadline = Date.now() + 10000
  while (!agent.connected() && Date.now() < deadline) await Bun.sleep(20)
  if (!agent.connected()) throw new Error("Agent did not connect")
  const invitation = pairing.issue({
    permissions: [
      "read",
      "prompt",
      "session.rename",
      "session.selection",
      "interrupt",
      "permission.reply",
      "question.reply",
      "session.create",
    ],
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
  await page.getByRole("button", { name: "下一页", exact: true }).click()
  await page.getByRole("button", { name: "Remote workspace", exact: true }).waitFor()
  await page.getByRole("button", { name: "上一页", exact: true }).click()
  await page.getByRole("button", { name: "Paged session 0", exact: true }).waitFor()
  await page.getByRole("button", { name: "下一页", exact: true }).click()
  await page.getByRole("button", { name: "Remote workspace", exact: true }).click()
  await page.getByText("已整理变更，等待你的下一步。", { exact: false }).waitFor()
  stage = "selection"
  await page.getByRole("button", { name: "Agent / 模型", exact: true }).click()
  stage = "selection-agent-open"
  await page.getByLabel("Agent", { exact: true }).selectOption("plan")
  await page.getByRole("button", { name: "保存 Agent", exact: true }).click()
  stage = "selection-agent-save"
  await page.getByText("Agent 已更新，下次模型调用起生效。", { exact: true }).waitFor()
  if (selectedAgent !== "plan") throw new Error("Agent selection was not applied")
  await page.getByRole("button", { name: "Agent / 模型", exact: true }).click()
  stage = "selection-model-open"
  await page.getByLabel("模型", { exact: true }).selectOption("0")
  stage = "selection-variant-open"
  await page.getByLabel("变体", { exact: true }).selectOption("reasoning")
  await page.getByRole("button", { name: "保存模型", exact: true }).click()
  stage = "selection-model-save"
  await page.getByText("模型已更新，下次模型调用起生效。", { exact: true }).waitFor()
  if (
    JSON.stringify(selectedModel) !==
    JSON.stringify({ model: { id: "fixture-model", providerID: "fixture", variant: "reasoning" } })
  )
    throw new Error("Model selection was not applied")
  stage = "diff"
  await page.getByRole("button", { name: "文件变化", exact: true }).click()
  await page.locator("#diff-content pre").getByText("+<script>unsafe()</script>", { exact: false }).waitFor()
  if (await page.locator("#diff-content script").count()) throw new Error("Diff content became executable markup")
  await page.getByRole("button", { name: "关闭文件变化", exact: true }).click()
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
  await page.getByRole("button", { name: "下一页", exact: true }).click()
  await page.getByRole("button", { name: "Renamed browser workspace", exact: true }).click()
  await page.waitForFunction(() => (document.getElementById("draft") as HTMLTextAreaElement).value === "尚未发送的草稿")
  if (prompted !== 1) throw new Error("Reconnect replayed a prompt")
  stage = "creation-recovery"
  await page.getByRole("button", { name: "新建会话", exact: true }).click()
  const creationDeadline = Date.now() + 5000
  while (!creationCalls && Date.now() < creationDeadline) await Bun.sleep(20)
  if (creationCalls !== 1) throw new Error("Creation request was not sent exactly once")
  await page.reload()
  await page.getByRole("button", { name: "Studio computer" }).click()
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent === "新建会话" && !button.disabled,
    ),
  )
  if (creationCalls !== 1) throw new Error("Lost creation response caused a replay")
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
  const page = browser?.contexts()[0]?.pages()[0]
  const selectionState = await page
    ?.evaluate(() => {
      const model = document.getElementById("model-choice")
      const dialog = document.getElementById("selection-dialog")
      return {
        options: model instanceof HTMLSelectElement ? model.options.length : -1,
        value: model instanceof HTMLSelectElement ? model.value : "missing",
        open: dialog instanceof HTMLDialogElement && dialog.open,
      }
    })
    .catch(() => undefined)
  console.error(
    JSON.stringify({
      stage,
      selectionState,
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
