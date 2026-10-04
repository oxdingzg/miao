import { expect, test } from "bun:test"
import { OpenCode } from "../src"

test("abort closes an idle SSE body even when the supplied fetch does not handle cancellation", async () => {
  const opened = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const client = OpenCode.make({
    baseUrl: "http://test",
    fetch: Object.assign(
      async () => {
        opened.resolve()
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled.resolve()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const abort = new AbortController()
  const iterator = client.events.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
  const pending = iterator.next()
  await opened.promise
  abort.abort("test cancellation")
  await expect(pending).rejects.toMatchObject({ reason: "Transport", cause: "test cancellation" })
  await cancelled.promise
})
