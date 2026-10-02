// The TUI's /remote logs in on this machine through createRemoteLocal when no
// daemon runs. It must use the same connector host and credentials file as
// `miao remote login`, so a daemon started afterwards picks the account up.
// Only the in-process login and status are exercised; launchctl is never run.
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "@miao/core/global"
import { createFakeQQ } from "@miao/remote/connectors/qq/fake-qq"
import { createRemoteLocal } from "../../src/cli/cmd/remote"

// The local host fetches through the global fetch, so the loopback guard from
// packages/remote/test/preload.ts is installed here for this file only.
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== "127.0.0.1") throw new Error(`remote tests must stay on 127.0.0.1; attempted ${url}`)
      return realFetch(input, init)
    },
    { preconnect: () => undefined },
  ) satisfies typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

test("logs in to QQ in this process, saves to the daemon's credentials file, and removes it again", async () => {
  const qq = createFakeQQ()
  try {
    qq.autoBind = "OWNER_OPENID"
    const local = await createRemoteLocal({ qq: { portal: qq.url, api: qq.url } })
    await expect(local.login("nope")).rejects.toThrow("没有名为 nope 的连接器")

    const flow = await local.login("qq")
    const steps = []
    for await (const step of local.events(flow, new AbortController().signal)) steps.push(step)
    expect(steps[0]).toMatchObject({ type: "qr" })
    expect(steps.at(-1)).toMatchObject({ type: "done", connector: "qq", account: { id: qq.appId } })

    const saved = (await Bun.file(path.join(Global.Path.data, "remote-auth.json")).json()) as {
      qq: Record<string, { owner: string; credentials: { appId: string } }>
    }
    expect(saved.qq[qq.appId]).toMatchObject({ owner: "OWNER_OPENID", credentials: { appId: qq.appId } })

    const status = await local.status()
    expect(status.map((connector) => connector.id)).toEqual(["wechat", "qq"])
    expect(status[1].accounts[0]).toMatchObject({ account: qq.appId, owner: "OWNE…OPENID", state: "offline" })

    await local.remove("qq", qq.appId)
    expect((await local.status())[1].accounts).toEqual([])
  } finally {
    qq.stop()
  }
})

test("a cancelled local login ends with an error step", async () => {
  const qq = createFakeQQ()
  try {
    const local = await createRemoteLocal({ qq: { portal: qq.url, api: qq.url } })
    const flow = await local.login("qq")
    const steps = []
    for await (const step of local.events(flow, new AbortController().signal)) {
      steps.push(step)
      if (step.type === "qr") await local.cancel(flow)
    }
    expect(steps.at(-1)).toEqual({ type: "error", message: "登录已取消或超时" })
  } finally {
    qq.stop()
  }
})
