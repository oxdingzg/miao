import { Effect, Schedule } from "effect"
import { PermissionV2 } from "@miao/core/permission"
import { Wildcard } from "@miao/core/util/wildcard"
import { Permission } from "@miao/schema/permission"
import { EngineError, type EngineClient } from "./client"
import type { Capabilities } from "./discovery"
import { messageID } from "./identity"
import { ProductPermissionRequest } from "./product-permission-request"

/** One live reverse call's permission adapter; authority stays in its engine. */
export function make(input: {
  client: Pick<EngineClient, "request">
  source: ProductPermissionRequest.Source
  capabilities: Capabilities
}): Pick<PermissionV2.Interface, "ask" | "assert"> {
  const source = new ProductPermissionRequest.Source(input.source)
  const read = Effect.fn("Engine.hostPermission.read")(function* (method: string, request: object, id: string) {
    const value = yield* Effect.tryPromise({
      try: () => input.client.request(method, { source, ...request }),
      catch: (error) =>
        error instanceof EngineError ? error : new EngineError("host_permission_failed", String(error)),
    }).pipe(Effect.orDie)
    const info = ProductPermissionRequest.parse(value, source.session_id)
    if (
      !info ||
      info.id !== id ||
      info.source.bridge_id !== source.bridge_id ||
      info.source.call_id !== source.call_id ||
      info.source.message_seq !== source.message_seq
    )
      return yield* Effect.die(new EngineError("host_permission_invalid", "Invalid native permission source binding"))
    return info
  })
  const admit = Effect.fn("Engine.hostPermission.admit")(function* (request: PermissionV2.AssertInput) {
    if (
      input.capabilities.productPermissionRequests !== 1 ||
      input.capabilities.productPermissionReplies !== 1 ||
      input.capabilities.productPermissionCancel !== 1 ||
      input.capabilities.productPermissionDiagnostics !== 1 ||
      input.capabilities.productPermissionAuto !== 1
    )
      return yield* Effect.die(
        new EngineError("host_permission_unsupported", "Native permission capabilities are missing"),
      )
    if (
      request.sessionID !== source.session_id ||
      request.source?.type !== "tool" ||
      request.source.callID !== source.call_id ||
      request.source.messageID !== messageID(source.session_id, source.message_seq)
    )
      return yield* Effect.die(
        new EngineError("host_permission_source_mismatch", "Permission source does not match its live tool"),
      )
    const id = request.id ?? Permission.ID.create()
    return yield* read(
      "product_permission_admit",
      {
        input: {
          request_id: id,
          facts: {
            actions: [request.action, ...(request.aliases ?? [])],
            resources: request.resources,
            explicit: request.explicit ?? false,
          },
          ...(request.save === undefined ? {} : { save: request.save }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
      },
      id,
    )
  })
  const finish = (info: ProductPermissionRequest.Info): Effect.Effect<void, PermissionV2.Error> => {
    if (info.state === "allowed") return Effect.void
    if (info.state === "cancelled" || info.state === "expired") return Effect.interrupt
    if (info.reason === "policy_denied" && info.denial)
      return Effect.fail(
        new PermissionV2.BlockedError({
          // Filter diagnostic display only; the native terminal state decides.
          rules: info.denial.rules.filter((rule) =>
            info.request.facts.actions.some((action) => Wildcard.match(action, rule.action)),
          ),
        }),
      )
    if (info.reason === "user_corrected" && info.feedback)
      return Effect.fail(new PermissionV2.CorrectedError({ feedback: info.feedback }))
    if (info.reason === "user_rejected") return Effect.die(new PermissionV2.DeclinedError())
    return Effect.die(new EngineError("host_permission_invalid", "Native permission has no valid terminal outcome"))
  }
  return {
    ask: (request) =>
      admit(request).pipe(
        Effect.map((info) => ({
          id: ProductPermissionRequest.id(info),
          effect: info.state === "pending" ? "ask" : info.state === "allowed" ? "allow" : "deny",
        })),
      ),
    assert: (request) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const info = yield* admit(request)
          const settled =
            info.state === "pending"
              ? read("product_permission_status", { request_id: info.id }, info.id).pipe(
                  Effect.repeat({
                    while: (record) => record.state === "pending",
                    schedule: Schedule.spaced("100 millis"),
                  }),
                )
              : Effect.succeed(info)
          return yield* restore(settled.pipe(Effect.flatMap(finish))).pipe(
            Effect.ensuring(
              info.state !== "pending"
                ? Effect.void
                : Effect.tryPromise({
                    try: () => input.client.request("product_permission_cancel", { source, request_id: info.id }),
                    catch: (error) =>
                      error instanceof EngineError ? error : new EngineError("host_permission_failed", String(error)),
                  }).pipe(
                    Effect.catch((error) =>
                      Effect.logDebug("Native permission cleanup could not reach its source", { code: error.code }),
                    ),
                  ),
            ),
          )
        }),
      ),
  }
}

export * as NativeHostPermission from "./native-host-permission"
