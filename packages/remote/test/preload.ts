// Safety net for every remote test: no request may leave the machine. Connector
// code receives an injected fetch in tests, but a missed injection must fail
// loudly instead of reaching a real IM service (q.qq.com, ilinkai.weixin.qq.com, ...).
// Patching the globals is the only way to cover code paths that do not take an
// injected fetch, such as WebSocket gateways.
function loopback(target: string | URL) {
  const url = new URL(String(target))
  if (url.hostname !== "127.0.0.1") throw new Error(`remote tests must stay on 127.0.0.1; attempted ${url}`)
}

const realFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    loopback(input instanceof Request ? input.url : input)
    return realFetch(input, init)
  },
  { preconnect: () => undefined },
) satisfies typeof fetch

const RealWebSocket = globalThis.WebSocket
globalThis.WebSocket = class extends RealWebSocket {
  constructor(url: string | URL, options?: string | string[] | Bun.WebSocketOptions) {
    loopback(url)
    super(url, options as string | string[])
  }
} as typeof WebSocket
