// QQ bot (QQ open platform): QR binding names the owner, the WebSocket gateway
// receives private messages, and late replies become proactive messages.
import { defineConnector } from "../../connector"
import type { Credentials } from "./api"
import { bindLogin } from "./bind"
import { createQQChannel, MaxLength } from "./channel"

export const qq = defineConnector<Credentials>({
  id: "qq",
  name: "QQ 机器人",
  description: "QQ 开放平台机器人：扫码绑定即确定主人；被动回复用完后自动改发主动消息，审批和结果都能及时送达",
  transport: "socket",
  capabilities: { buttons: false, push: true, maxLength: MaxLength },
  notice:
    "提示：扫码后在手机 QQ 里新建一个专用机器人（一个 QQ 号最多 5 个）。选一个正在为其它服务在线的机器人会断开它原来的连接。",
  login: bindLogin,
  parse: (value) => {
    if (typeof value !== "object" || value === null) return undefined
    const candidate = value as Partial<Credentials>
    if (typeof candidate.appId !== "string" || !candidate.appId) return undefined
    if (typeof candidate.secret !== "string" || !candidate.secret) return undefined
    return { appId: candidate.appId, secret: candidate.secret }
  },
  connect: (credentials, context) =>
    createQQChannel({
      credentials,
      stateDir: context.stateDir,
      owner: context.owner,
      markNeedsLogin: context.markNeedsLogin,
      api: typeof context.options.api === "string" && context.options.api ? context.options.api : undefined,
      markdown: context.options.markdown !== false,
      fetch: context.fetch,
      log: context.log,
      now: context.now,
      reconnectMs: typeof context.options.reconnect_ms === "number" ? context.options.reconnect_ms : undefined,
    }),
})
