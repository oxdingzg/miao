// A local stand-in for the iLink HTTP API, for tests. It scripts getupdates
// batches, QR status answers, and sendmessage results, and records every request.
// getupdates with nothing scripted is held open like the real long poll.
import type { QrStatusResponse, SendResponse, WeixinMessage } from "./ilink"

export type FakeRequest = {
  readonly path: string
  readonly query: URLSearchParams
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

export type UpdateScript =
  | {
      readonly msgs?: ReadonlyArray<WeixinMessage>
      readonly buf?: string
      readonly ret?: number
      readonly errcode?: number
      readonly errmsg?: string
      readonly longpolling_timeout_ms?: number
    }
  | { readonly status: number }

export function createFakeIlink() {
  const requests: FakeRequest[] = []
  const updates: UpdateScript[] = []
  const sends: Array<SendResponse | { readonly status: number }> = []
  const statuses: QrStatusResponse[] = []
  const waiters = new Set<() => void>()
  const counter = { qrcodes: 0, messageID: 9_007_199_254_740_993n }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body =
        request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}
      requests.push({ path: url.pathname, query: url.searchParams, headers: Object.fromEntries(request.headers), body })
      waiters.forEach((wake) => wake())
      if (url.pathname === "/ilink/bot/get_bot_qrcode") {
        counter.qrcodes += 1
        return Response.json({
          qrcode: `qr-${counter.qrcodes}`,
          qrcode_img_content: `https://qr.example/${counter.qrcodes}`,
        })
      }
      if (url.pathname === "/ilink/bot/get_qrcode_status") return Response.json(statuses.shift() ?? { status: "wait" })
      if (url.pathname === "/ilink/bot/getupdates")
        return getUpdates(String(body.get_updates_buf ?? ""), request.signal)
      if (url.pathname === "/ilink/bot/sendmessage") {
        const next = sends.shift() ?? { ret: 0, message_id: String(counter.messageID++) }
        if ("status" in next && typeof next.status === "number") return new Response("error", { status: next.status })
        return raw(next)
      }
      if (url.pathname === "/ilink/bot/getconfig") return Response.json({ ret: 0, typing_ticket: "ticket-1" })
      return Response.json({ ret: 0 })
    },
  })

  async function getUpdates(cursor: string, signal: AbortSignal): Promise<Response> {
    const next = updates.shift()
    if (next && "status" in next) return new Response("unavailable", { status: next.status })
    if (next)
      return raw({
        ret: next.ret ?? 0,
        ...(next.errcode !== undefined ? { errcode: next.errcode } : {}),
        ...(next.errmsg !== undefined ? { errmsg: next.errmsg } : {}),
        msgs: next.msgs ?? [],
        get_updates_buf: next.buf ?? cursor,
        ...(next.longpolling_timeout_ms ? { longpolling_timeout_ms: next.longpolling_timeout_ms } : {}),
      })
    // Hold the poll open until something is scripted or the client gives up.
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (updates.length === 0 && !signal.aborted) return
        waiters.delete(wake)
        resolve()
      }
      waiters.add(wake)
      signal.addEventListener("abort", wake, { once: true })
    })
    if (signal.aborted) return new Response(null, { status: 499 })
    return getUpdates(cursor, signal)
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    host: `127.0.0.1:${server.port}`,
    requests,
    /** Queues the next getupdates answer and releases a held poll. */
    update: (script: UpdateScript) => {
      updates.push(script)
      waiters.forEach((wake) => wake())
    },
    sendResult: (result: SendResponse | { readonly status: number }) => sends.push(result),
    status: (...results: QrStatusResponse[]) => statuses.push(...results),
    /** Texts delivered through sendmessage, in order. */
    sent: () =>
      requests
        .filter((request) => request.path === "/ilink/bot/sendmessage")
        .map(
          (request) =>
            request.body.msg as {
              to_user_id: string
              context_token?: string
              client_id: string
              item_list: Array<{ text_item: { text: string } }>
            },
        ),
    /** Resolves once a request matching the predicate has been recorded. */
    until: (match: (request: FakeRequest) => boolean, timeoutMs = 10_000) =>
      new Promise<FakeRequest>((resolve, reject) => {
        const check = () => {
          const found = requests.find(match)
          if (!found) return
          waiters.delete(check)
          clearTimeout(timer)
          resolve(found)
        }
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`fake iLink: no matching request within ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.add(check)
        check()
      }),
    stop: () => server.stop(true),
  }
}

/** JSON with uint64 message ids written as bare numbers, the way iLink sends them. */
function raw(value: unknown) {
  return new Response(JSON.stringify(value).replace(/"(message_id)":"(\d+)"/g, '"$1":$2'), {
    headers: { "content-type": "application/json" },
  })
}

let sequence = 0

/** Builds an inbound user text message. */
export function textMessage(input: { from: string; text: string; context?: string; id?: string; seq?: number }) {
  sequence += 1
  return {
    seq: input.seq ?? sequence,
    message_id: input.id ?? String(7_000_000_000_000_000_000n + BigInt(sequence)),
    from_user_id: input.from,
    to_user_id: "bot",
    create_time_ms: 1_790_000_000_000 + sequence,
    message_type: 1,
    context_token: input.context ?? `ctx-${sequence}`,
    item_list: [{ type: 1, text_item: { text: input.text } }],
  } satisfies WeixinMessage
}
