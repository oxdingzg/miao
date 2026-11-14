import { LLMClient, RequestExecutor } from "@miao/llm/route"
import type { LLMRequest, LLMResponse } from "@miao/llm"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export type Wire = {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

/**
 * Sends `request` through the real route pipeline against an in-process fake
 * provider: the captured request is what would have gone on the wire, and the
 * canned `response` body exercises the route's stream parser. No network.
 *
 * `extra` reaches both sites that read their context while being built — the
 * executor and the client — because each resolves such services on its own, so
 * handing it to one of them leaves the other blind. That is how the host's
 * provider wire archive gets into a real request.
 */
export const exchange = (
  request: LLMRequest,
  response: ConstructorParameters<typeof Response>[0],
  init: ResponseInit = { headers: { "content-type": "text/event-stream" } },
  extra: Layer.Layer<never, never, never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const captured: Wire[] = []
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((outgoing) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(outgoing).pipe(Effect.orDie)
          const text = yield* Effect.promise(() => web.text())
          captured.push({
            url: web.url,
            headers: Object.fromEntries(web.headers.entries()),
            body: text ? JSON.parse(text) : {},
          })
          return HttpClientResponse.fromWeb(outgoing, new Response(response, init))
        }),
      ),
    )
    const client = LLMClient.layer.pipe(
      Layer.provide(Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(Layer.mergeAll(http, extra))), extra)),
    )
    const result: LLMResponse = yield* LLMClient.generate(request).pipe(Effect.provide(client))
    return { wire: captured[0]!, response: result }
  })

export const sse = (events: ReadonlyArray<unknown>) =>
  events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
