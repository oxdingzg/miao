import { Location } from "@miao/core/location"
import { Database } from "@miao/core/database/database"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { PermissionV2 } from "@miao/core/permission"
import { PermissionSaved } from "@miao/core/permission/saved"
import { PermissionHandoff } from "@miao/core/permission/handoff"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { NativeEngine } from "../native-engine"
import { ConflictError, PermissionNotFoundError, SessionNotFoundError } from "@miao/protocol/errors"
import { booted, response } from "../location"

function missingRequest(id: PermissionV2.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const savedOwnership = (projectID: PermissionSaved.Info["projectID"]) =>
      PermissionHandoff.read(database.db, projectID).pipe(
        Effect.mapError(
          () => new ConflictError({ resource: projectID, message: "Saved permission ownership could not be verified" }),
        ),
      )
    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          const permission = yield* PermissionV2.Service
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const host = yield* permission.list()
          if (Option.isNone(native)) return yield* response(Effect.succeed(host))
          const location = yield* Location.Service
          const placements = yield* SessionEnginePlacement.list(database.db)
          const pending = yield* Effect.forEach(
            placements.filter(
              (item) =>
                item.location.directory === location.directory && item.location.workspaceID === location.workspaceID,
            ),
            (item) => native.value.permissions(item).pipe(Effect.orDie),
            { concurrency: 4 },
          )
          return yield* response(Effect.succeed([...host, ...pending.flat()]))
        }),
      )
      .handle(
        "session.permission.create",
        Effect.fn(function* (ctx) {
          const placement = yield* SessionEnginePlacement.find(database.db, ctx.params.sessionID)
          if (placement?.engine === "rust")
            return yield* new ConflictError({
              resource: ctx.params.sessionID,
              message: "Native permission requests require an active engine-owned tool invocation",
            })
          yield* booted
          const permission = yield* PermissionV2.Service
          return {
            data: yield* permission
              .ask({
                id: ctx.payload.id,
                sessionID: ctx.params.sessionID,
                action: ctx.payload.action,
                resources: ctx.payload.resources,
                save: ctx.payload.save,
                metadata: ctx.payload.metadata,
                source: ctx.payload.source,
                agent: ctx.payload.agent,
              })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const permission = yield* PermissionV2.Service
            const host = yield* permission.forSession(ctx.params.sessionID)
            const pending = yield* native.value.permissions({ sessionID: ctx.params.sessionID, ...placement })
            return { data: [...pending, ...host] }
          }
          const permission = yield* PermissionV2.Service
          return { data: yield* permission.forSession(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.permission.get",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const permission = yield* PermissionV2.Service
            const host = yield* permission.get(ctx.params.requestID)
            if (host?.sessionID === ctx.params.sessionID) return { data: host }
            const pending = yield* native.value.permissions({ sessionID: ctx.params.sessionID, ...placement })
            const request = pending.find((request) => request.id === ctx.params.requestID)
            if (!request) return yield* missingRequest(ctx.params.requestID)
            return { data: request }
          }
          const request = yield* (yield* PermissionV2.Service).get(ctx.params.requestID)
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          return { data: request }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          const permission = yield* PermissionV2.Service
          const request = yield* permission.get(ctx.params.requestID)
          if (Option.isSome(native) && placement && !request) {
            const pending = yield* native.value.permissions({ sessionID: ctx.params.sessionID, ...placement })
            if (!pending.some((p) => p.id === ctx.params.requestID)) return yield* missingRequest(ctx.params.requestID)
            yield* native.value.replyPermission({
              sessionID: ctx.params.sessionID,
              requestID: ctx.params.requestID,
              ...ctx.payload,
              ...placement,
            })
            return HttpApiSchema.NoContent.make()
          }
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          yield* permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(Effect.catchTag("PermissionV2.NotFoundError", () => missingRequest(ctx.params.requestID)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          const saved = yield* PermissionSaved.Service
          const projectID = ctx.query.projectID ?? location.project.id
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          if (
            Option.isNone(native) ||
            !native.value.savedPermissions ||
            (ctx.query.projectID !== undefined && ctx.query.projectID !== location.project.id)
          ) {
            if (yield* savedOwnership(projectID))
              return yield* new ConflictError({
                resource: projectID,
                message: "Shared saved permissions require the owning native Location",
              })
            return { data: yield* saved.list({ projectID }) }
          }
          const projected = yield* native.value.savedPermissions({
            location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
            projectID: location.project.id,
          })
          // Opening the native owner may complete the handoff. Read ownership
          // after that boundary; frozen Core rows must neither be read nor
          // duplicated beside their authoritative Root copies.
          const handoff = yield* savedOwnership(projectID)
          const legacy = handoff ? [] : yield* saved.list({ projectID })
          return { data: [...legacy, ...projected] }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          const handoff = yield* savedOwnership(location.project.id)
          if (ctx.params.id.startsWith(PermissionSaved.NativePrefix) || handoff) {
            const native = yield* Effect.serviceOption(NativeEngine.Service)
            if (Option.isNone(native) || !native.value.removeSavedPermission)
              return yield* new ConflictError({
                resource: ctx.params.id,
                message: "Native saved-rule control is unavailable",
              })
            yield* native.value.removeSavedPermission({
              id: ctx.params.id,
              location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
            })
            return HttpApiSchema.NoContent.make()
          }
          const saved = yield* PermissionSaved.Service
          yield* saved.remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
