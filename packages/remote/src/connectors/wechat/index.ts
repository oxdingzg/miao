// WeChat ClawBot (iLink): QR login identifies the owner, long polling receives.
import { callbackLogin, defineConnector } from "../../connector"
import { createWechatChannel, MaxLength, ReplyWindowMs } from "./channel"
import { createLoginApi } from "./ilink"
import { login, parseCredentials } from "./login"

export const DefaultPushBudget = 4

export const wechat = defineConnector({
  id: "wechat",
  name: "微信",
  description: "微信 ClawBot（iLink）：扫码即绑定主人，一问一答，主动推送每天有预算",
  transport: "poll",
  capabilities: {
    buttons: false,
    push: true,
    maxLength: MaxLength,
    pushBudgetPerDay: DefaultPushBudget,
    replyWindowMs: ReplyWindowMs,
    repliesPerInbound: 10,
  },
  notice: [
    "风险提示：腾讯没有明确允许或禁止第三方客户端使用微信 ClawBot（iLink）。目前没有因此封微信号的报告，",
    "但有 bot 下行消息被风控、几天到三周才恢复的报告。miao 会把每天的主动推送控制在配置的预算内。",
  ].join("\n"),
  login: (context) =>
    callbackLogin(
      (io) =>
        login({
          api: createLoginApi({ fetch: context.fetch, baseUrl: stringOption(context.options, "base_url") }),
          show: (content) => io.show({ type: "qr", content, hint: "用手机微信扫码，然后在手机上确认" }),
          ask: io.ask,
          say: (message) => io.show({ type: "progress", message }),
          now: context.now,
          signal: context.signal,
        }),
      (result) =>
        result.ok
          ? {
              type: "done",
              account: { id: result.credentials.botID, label: "微信 ClawBot" },
              owner: result.credentials.userID,
              credentials: result.credentials,
              message: "只接受扫码者本人的消息",
            }
          : { type: "error", message: result.message },
    ),
  parse: parseCredentials,
  connect: (credentials, context) =>
    createWechatChannel({
      credentials,
      stateDir: context.stateDir,
      markNeedsLogin: context.markNeedsLogin,
      agentVersion: context.agentVersion,
      pushBudgetPerDay: numberOption(context.options, "push_budget_per_day"),
      fetch: context.fetch,
      log: context.log,
      now: context.now,
    }),
})

function stringOption(options: Readonly<Record<string, unknown>>, key: string) {
  const value = options[key]
  return typeof value === "string" && value ? value : undefined
}

function numberOption(options: Readonly<Record<string, unknown>>, key: string) {
  const value = options[key]
  return typeof value === "number" ? value : undefined
}
