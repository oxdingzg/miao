import { ConflictError, InvalidRequestError } from "@miao/protocol/errors"
import { LoginStep, RemoteNotFoundError } from "@miao/protocol/groups/remote"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { RemoteControl } from "../remote-control"

const notRemote = new RemoteNotFoundError({ message: "这个服务不是 miao remote 守护进程" })

export const RemoteHandler = HttpApiBuilder.group(Api, "server.remote", (handlers) =>
  Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(RemoteControl.Service)
    const control = Effect.fromOption(provided).pipe(Effect.mapError(() => notRemote))
    const missing = (message: string) => new RemoteNotFoundError({ message })

    return handlers
      .handle(
        "remote.get",
        Effect.fn(function* () {
          const remote = yield* control
          return yield* Effect.promise(() => remote.status())
        }),
      )
      .handle(
        "remote.login.start",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const started = yield* Effect.promise(() => remote.login(ctx.params.connector))
          if (!started) return yield* missing(`没有名为 ${ctx.params.connector} 的连接器`)
          return started
        }),
      )
      .handleRaw(
        "remote.login.events",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const steps = remote.events(ctx.params.flow)
          if (!steps) return yield* missing("登录流程不存在或已过期")
          const output = Stream.fromAsyncIterable(steps, (cause) => new Error(String(cause))).pipe(
            Stream.map(
              (step): Sse.Event => ({
                _tag: "Event",
                event: "message",
                id: undefined,
                data: JSON.stringify(Schema.encodeUnknownSync(LoginStep)(step)),
              }),
            ),
            Stream.pipeThroughChannel(Sse.encode()),
          )
          const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
          return HttpServerResponse.stream(
            output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
            {
              contentType: "text/event-stream",
              headers: { "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
            },
          )
        }),
      )
      .handle(
        "remote.login.input",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const result = remote.input(ctx.params.flow, ctx.payload.value)
          if (result === "unknown") return yield* missing("登录流程不存在或已过期")
          if (result === "idle") return yield* new ConflictError({ message: "这个登录步骤不需要输入" })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "remote.login.cancel",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          if (!remote.cancel(ctx.params.flow)) return yield* missing("登录流程不存在或已过期")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "remote.account.remove",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const removed = yield* Effect.promise(() => remote.remove(ctx.params.connector, ctx.params.account))
          if (!removed) return yield* missing("账号不存在")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "remote.account.pair",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const result = yield* Effect.promise(() => remote.pair(ctx.params.connector, ctx.params.account))
          if (!result) return yield* missing("账号不存在")
          if ("error" in result) return yield* new InvalidRequestError({ message: result.error })
          return result
        }),
      )
      .handle(
        "remote.account.test",
        Effect.fn(function* (ctx) {
          const remote = yield* control
          const result = yield* Effect.promise(() => remote.test(ctx.params.connector, ctx.params.account))
          if (!result) return yield* missing("账号不存在")
          return result
        }),
      )
  }),
)
