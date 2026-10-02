// Every built-in connector, plus the in-memory pairing connector, runs the shared
// conformance suite against a local fake of its network.
import { qq } from "../src/connectors/qq"
import { createFakeQQ } from "../src/connectors/qq/fake-qq"
import { wechat } from "../src/connectors/wechat"
import { createFakeIlink, textMessage } from "../src/connectors/wechat/fake-ilink"
import { connectorConformance, loopbackFetch } from "../src/testing"
import { createEchoNetwork, echo } from "./fixtures/echo-connector"

connectorConformance(
  wechat,
  async () => {
    const ilink = createFakeIlink()
    const owner = "owner@im.wechat"
    // iLink re-delivers the exact same message (same seq and timestamp), so keep one per id.
    const messages = new Map<string, ReturnType<typeof textMessage>>()
    return {
      options: { base_url: ilink.url },
      owner,
      stranger: "stranger@im.wechat",
      onLoginStep: (step) => {
        if (step.type !== "qr") return undefined
        ilink.status({
          status: "confirmed",
          bot_token: "bot-token",
          ilink_bot_id: "bot@im.bot",
          baseurl: ilink.url,
          ilink_user_id: owner,
        })
        return undefined
      },
      deliver: (message) => {
        const existing = messages.get(message.id) ?? textMessage({ from: message.from, text: message.text })
        messages.set(message.id, existing)
        ilink.update({ msgs: [existing] })
      },
      sent: () =>
        ilink.sent().map((message) => ({ to: message.to_user_id, text: message.item_list[0].text_item.text })),
      drop: () => ilink.update({ status: 503 }),
      stop: () => ilink.stop(),
    }
  },
  { fetch: loopbackFetch },
)

connectorConformance(
  qq,
  async () => {
    const fake = createFakeQQ()
    const owner = "OWNER_OPENID"
    return {
      options: { portal: fake.url, api: fake.url, bind_poll_ms: 10, reconnect_ms: 20 },
      owner,
      stranger: "STRANGER_OPENID",
      onLoginStep: async (step) => {
        if (step.type === "qr") await fake.completeBind(owner)
        return undefined
      },
      deliver: (message) => fake.c2c(message),
      sent: () =>
        fake
          .delivered()
          .filter((message) => message.msg_type !== 6)
          .map((message) => ({
            to: message.to,
            text: String((message.markdown as { content?: string } | undefined)?.content ?? message.content),
          })),
      drop: () => fake.close(4009),
      stop: () => fake.stop(),
    }
  },
  { fetch: loopbackFetch },
)

connectorConformance(echo, async () => {
  const network = createEchoNetwork()
  return {
    options: { network },
    owner: "owner-1",
    stranger: "stranger-1",
    onLoginStep: (step) => (step.type === "form" ? { token: "t1" } : undefined),
    deliver: (message) => network.deliver(message),
    sent: () => network.sent,
    drop: () => network.drop(),
    stop: () => undefined,
  }
})
