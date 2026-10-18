import path from "node:path"
import { Image } from "@miao/core/image"
import { Database } from "@miao/core/database/database"
import { Catalog } from "@miao/core/catalog"
import { SessionV2 } from "@miao/core/session"
import { SkillV2 } from "@miao/core/skill"
import { AgentV2 } from "@miao/core/agent"
import { PluginV2 } from "@miao/core/plugin"
import { SessionImageNormalize } from "@miao/core/session/image-normalize"
import { SessionUsageStore } from "@miao/core/session/usage-store"
import { Clock, DateTime, Deferred, Effect, Option, Schema, Stream } from "effect"
import { BackgroundJob } from "@miao/core/background-job"
import { SessionBackgroundJobs } from "@miao/core/session/background-jobs"
import { SessionSchedule } from "@miao/core/session/schedule"
import { SessionDelegationStore } from "@miao/core/session/delegation-store"
import { EventV2 } from "@miao/core/event"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { Project } from "@miao/core/project"
import { NativeEngine } from "../native-engine"
import { requireNativeOwner, requireTypescriptOwner } from "../native-command"
import { SessionEnginePlacement } from "@miao/core/session/engine-placement"
import { nativeExecution, nativeTodos } from "../native-state"
import { nativeSessionEvents } from "../native-events"
import { SessionEvent } from "@miao/schema/session-event"
import { mergeNativeSessions, nativeSessionInfo, nativeSessionUsage, waitNative } from "../native-session"
import { booted } from "../location"
import { SessionsCursor } from "@miao/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@miao/protocol/errors"
import { AbsolutePath } from "@miao/core/schema"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

const legacyNotMigrated = (error: SessionV2.LegacyNotMigratedError) =>
  new ServiceUnavailableError({ message: error.message, service: "session-migration" })

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    // Pricing is a product catalog fact; the constrained cli/listener
    // assembly does not boot it, so missing pricing degrades the projection
    // to zero cost with tokens still attributed.
    const availableModels = Effect.gen(function* () {
      const catalog = yield* Effect.serviceOption(Catalog.Service)
      if (Option.isNone(catalog)) return []
      return yield* catalog.value.model.available()
    })
    const schedule = Option.getOrUndefined(yield* Effect.serviceOption(SessionSchedule.Service))
    const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const limit = ctx.query.limit ?? DefaultSessionsLimit
          const sessions = yield* session.list({ ...query, workspaceID: query.workspace, limit })
          // Native Sessions live in the engine's storage, not this catalog.
          // They join every page under the same `(time, id)` anchor: both
          // sources cut at the same element, so the merged page continues
          // seamlessly across sources in both directions.
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const projects = Option.getOrUndefined(yield* Effect.serviceOption(Project.Service))
          const merged =
            Option.isSome(native) && projects !== undefined
              ? yield* mergeNativeSessions({
                  native: native.value,
                  db,
                  sessions,
                  limit,
                  models: yield* availableModels,
                  order: query.order ?? "desc",
                  search: query.search,
                  anchor: "anchor" in query ? query.anchor : undefined,
                  directory: "directory" in query ? query.directory : undefined,
                  project: "project" in query ? query.project : undefined,
                  projects,
                }).pipe(Effect.orDie)
              : sessions
          const first = merged[0]
          const last = merged.at(-1)
          return {
            data: merged,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          const id = ctx.payload.id ?? SessionV2.ID.create()
          const binding = yield* SessionEnginePlacement.find(db, id)
          const location = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          // New Sessions are born on the engine only when the operator pointed
          // the server at an engine storage root and a native transport is
          // composed; the placement catalog then routes every surface for that
          // identity. Everything else stays TypeScript-owned.
          const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
          const root = process.env.MIAO_ENGINE_STORAGE
          const nativeStorage =
            native && root && !binding
              ? AbsolutePath.make(
                  path.resolve(
                    root,
                    `${new Bun.CryptoHasher("sha256").update(JSON.stringify(location)).digest("hex")}.db`,
                  ),
                )
              : undefined
          // Initialize the engine before publishing its placement: get/list
          // must work even when no prompt has ever been submitted. Retrying a
          // catalogued identity preserves its original placement.
          if (native && nativeStorage)
            yield* native.initialize({ sessionID: id, storage: nativeStorage, location, title: "New session" })
          if (binding?.engine === "rust" && !native)
            return yield* new ConflictError({ message: "Native engine transport is not composed", resource: id })
          const created = yield* session.create({
            id,
            agent: ctx.payload.agent,
            model: ctx.payload.model,
            location,
            ...(nativeStorage ? { nativeStorage } : {}),
          })
          const placement =
            binding?.engine === "rust" ? binding : nativeStorage ? { storage: nativeStorage, location } : undefined
          if (native && placement) {
            const snapshot = yield* native.snapshot({
              sessionID: id,
              storage: placement.storage,
              location: placement.location,
            })
            return {
              data: nativeSessionInfo({
                sessionID: id,
                projectID: created.projectID,
                location: placement.location,
                snapshot,
              }),
            }
          }
          return { data: created }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          // A native Session is stored by the engine; its snapshot is the only
          // authority for identity, title, and time.
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const snapshot = yield* native.value.snapshot({
              sessionID: ctx.params.sessionID,
              storage: placement.storage,
              location: placement.location,
            })
            const project = yield* (yield* Project.Service).resolve(placement.location.directory)
            const usage = nativeSessionUsage({
              report: yield* native.value.usage({ sessionID: ctx.params.sessionID, ...placement }),
              models: yield* availableModels,
              snapshot,
            })
            return {
              data: nativeSessionInfo({
                sessionID: ctx.params.sessionID,
                projectID: project.id,
                location: placement.location,
                snapshot,
                usage,
              }),
            }
          }
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          // One indexed aggregate per read: lifetime facts the loaded
          // transcript cannot show once it pages.
          const usage = yield* SessionUsageStore.summary(db, ctx.params.sessionID)
          return { data: usage === undefined ? info : { ...info, usage } }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          const placement = yield* Effect.serviceOption(NativeEngine.Placement)
          if (Option.isSome(placement)) {
            const owner = yield* requireNativeOwner(ctx.params.sessionID)
            const plugins = yield* PluginV2.Service
            yield* Deferred.await(plugins.booted)
            const agents = yield* AgentV2.Service
            const agent = yield* agents.get(ctx.payload.agent)
            if (!agent) return yield* new ConflictError({ message: `Agent is not selectable: ${ctx.payload.agent}` })
            yield* owner.native.selectAgent({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
              agent,
            })
            return HttpApiSchema.NoContent.make()
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.switchAgent")
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.modelRoutes",
        Effect.fn(function* (ctx) {
          const owner = yield* requireNativeOwner(ctx.params.sessionID)
          return {
            data: yield* owner.native.modelRoutes({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
            }),
          }
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          const placement = yield* Effect.serviceOption(NativeEngine.Placement)
          if (Option.isSome(placement)) {
            const owner = yield* requireNativeOwner(ctx.params.sessionID)
            yield* owner.native.selectModel({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
              model: ctx.payload.model,
            })
            return HttpApiSchema.NoContent.make()
          }
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchAccount",
        Effect.fn(function* (ctx) {
          const placement = yield* Effect.serviceOption(NativeEngine.Placement)
          if (Option.isSome(placement)) {
            const owner = yield* requireNativeOwner(ctx.params.sessionID)
            yield* owner.native.selectAccount({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
              credentialID: ctx.payload.credentialID,
            })
            return HttpApiSchema.NoContent.make()
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.switchAccount")
          yield* session
            .switchAccount({ sessionID: ctx.params.sessionID, credentialID: ctx.payload.credentialID })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.recoveries",
        Effect.fn(function* (ctx) {
          const owner = yield* requireNativeOwner(ctx.params.sessionID)
          return {
            data: yield* owner.native.recoveries({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
              after: ctx.query.after,
            }),
          }
        }),
      )
      .handle(
        "session.resolveRecovery",
        Effect.fn(function* (ctx) {
          const owner = yield* requireNativeOwner(ctx.params.sessionID)
          return {
            data: yield* owner.native.resolveRecovery({
              sessionID: ctx.params.sessionID,
              storage: owner.placement.storage,
              location: owner.placement.location,
              ...ctx.payload,
            }),
          }
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          // A composed native transport owns this Session's storage: admit into
          // the engine instead of the TypeScript SessionV2 catalog. The
          // placement was resolved by the location middleware.
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          // Composing the native transport does not migrate existing TS Sessions.
          // Only a resolved Rust placement selects native admission.
          if (Option.isSome(native) && placement) {
            // Last point before the prompt becomes durable, and the only one that
            // holds the session Location's services, so image attachments are
            // shrunk to the configured budget here rather than stored at full size.
            const image = yield* Image.Service
            const prompt = yield* SessionImageNormalize.promptInput(image, ctx.payload.prompt)
            return {
              data: yield* native.value.admit({
                sessionID: ctx.params.sessionID,
                storage: placement.storage,
                location: placement.location,
                id: ctx.payload.id,
                prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              }),
            }
          }
          // Last point before the prompt becomes durable, and the only one that
          // holds the session Location's services, so image attachments are
          // shrunk to the configured budget here rather than stored at full size.
          const image = yield* Image.Service
          const prompt = yield* SessionImageNormalize.promptInput(image, ctx.payload.prompt)
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
              ),
          }
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (native && placement) {
            yield* booted
            const skills = yield* SkillV2.Service
            const skill = (yield* skills.list()).find((item) => item.name === ctx.payload.skill)
            if (!skill)
              return yield* new SessionNotFoundError({
                sessionID: ctx.params.sessionID,
                message: `Skill not found: ${ctx.payload.skill}`,
              })
            return yield* native.inject({
              sessionID: ctx.params.sessionID,
              ...placement,
              text: skill.content,
              source: `skill:${skill.name}`,
              resume: ctx.payload.resume,
            })
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.skill")
          yield* session
            .skill({
              sessionID: ctx.params.sessionID,
              skill: ctx.payload.skill,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session or skill not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
            )
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.shell")
          yield* session
            .shell({
              sessionID: ctx.params.sessionID,
              command: ctx.payload.command,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
            )
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            // The engine records a durable request and honours it at the next
            // settled assistant boundary; an idle Session therefore compacts on
            // its next provider turn rather than in the middle of one.
            yield* native.value.requestCompact({
              sessionID: ctx.params.sessionID,
              storage: placement.storage,
              location: placement.location,
            })
            return
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.compact")
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
            Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          // A composed native transport owns its Sessions' execution, so the
          // TypeScript catalog has no run to wait on and would report idle
          // immediately; the engine decides when the Session would be idle.
          const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (native && placement) {
            yield* waitNative({ native, sessionID: ctx.params.sessionID, ...placement })
            return HttpApiSchema.NoContent.make()
          }
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.revert.stage")
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.revert.clear")
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.revert.commit")
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (placement) {
            const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
            if (!native)
              return yield* new ConflictError({ message: "Native engine is unavailable for context history" })
            return {
              data: yield* native.transcript({
                ...placement,
                sessionID: ctx.params.sessionID,
                selected: true,
              }),
            }
          }
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.todo",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const snapshot = yield* native.value.snapshot({ sessionID: ctx.params.sessionID, ...placement })
            return { data: nativeTodos(snapshot) }
          }
          return {
            data: yield* session.todo(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.rename",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement)
            return yield* native.value.rename({
              sessionID: ctx.params.sessionID,
              title: ctx.payload.title,
              ...placement,
            })
          yield* session.rename({ sessionID: ctx.params.sessionID, title: ctx.payload.title }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
        }),
      )
      .handle(
        "session.archive",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            yield* native.value.archive({
              sessionID: ctx.params.sessionID,
              storage: placement.storage,
              location: placement.location,
              archived: ctx.payload.archived,
            })
            // The engine owns the projection, but the product catalog still
            // backs `session list` in the CLI, so the archive fact is recorded
            // on both sides of the boundary.
            yield* session.archive({ sessionID: ctx.params.sessionID, archived: ctx.payload.archived }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            return
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.archive")
          yield* session.archive({ sessionID: ctx.params.sessionID, archived: ctx.payload.archived }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
        }),
      )
      .handle(
        "session.remove",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            yield* native.value.remove({
              sessionID: ctx.params.sessionID,
              storage: placement.storage,
              location: placement.location,
            })
            // Release the catalog binding before the product rows go: a stale
            // binding would route the next create of this identity back to a
            // storage that no longer has it.
            yield* SessionEnginePlacement.release(db, ctx.params.sessionID)
            yield* session
              .remove(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void))
            return
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.remove")
          yield* session.remove(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.command")
          // Plugins add commands such as /init and /review while a location boots; wait for them.
          yield* booted
          yield* session
            .command({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              command: ctx.payload.command,
              arguments: ctx.payload.arguments,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session or command not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Command message ID conflicts with an existing durable record: ${error.messageID}`,
                    resource: error.messageID,
                  }),
                ),
              ),
              Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
            )
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const targetSessionID = SessionV2.ID.create()
            yield* native.value.fork({
              sessionID: ctx.params.sessionID,
              targetSessionID,
              messageID: ctx.payload.messageID,
              ...placement,
            })
            const child = yield* session.create({
              id: targetSessionID,
              parentID: ctx.params.sessionID,
              location: placement.location,
              nativeStorage: placement.storage,
            })
            const snapshot = yield* native.value.snapshot({ sessionID: targetSessionID, ...placement })
            return {
              data: nativeSessionInfo({
                sessionID: targetSessionID,
                projectID: child.projectID,
                location: placement.location,
                snapshot,
              }),
            }
          }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.fork")
          return {
            data: yield* session.fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.LegacyNotMigratedError", (error) => Effect.fail(legacyNotMigrated(error))),
            ),
          }
        }),
      )
      .handle(
        "session.diff",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .diff(ctx.params.sessionID, {
                messageID: ctx.query.messageID,
                patch: ctx.query.patch,
                path: ctx.query.path,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.inputs",
        Effect.fn(function* (ctx) {
          const page = yield* session
            .inputs({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
          return { data: page.inputs, hasMore: page.hasMore }
        }),
      )
      .handle(
        "session.inputCancel",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement)
            return {
              cancelled: yield* native.value.cancelInput({
                sessionID: ctx.params.sessionID,
                storage: placement.storage,
                location: placement.location,
                inputID: ctx.params.messageID,
              }),
            }
          yield* requireTypescriptOwner(ctx.params.sessionID, "session.inputCancel")
          const cancelled = yield* session
            .cancelInput({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
          return { cancelled }
        }),
      )
      .handle(
        "session.activity",
        Effect.fn(function* (ctx) {
          const status = yield* session.status(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const background = SessionBackgroundJobs.make({ db, events, sessionID: ctx.params.sessionID, jobs })
          return {
            data: {
              observedAt: yield* Clock.currentTimeMillis,
              status,
              pendingNotifications: yield* SessionDelegationStore.pendingCount(db, ctx.params.sessionID),
              schedules: schedule ? yield* schedule.list(ctx.params.sessionID) : [],
              jobs: (yield* background.observe()).map((job) => ({
                id: job.id,
                title: job.title,
                status: job.status,
                startedAt: job.started_at,
                completedAt: job.completed_at,
                error: job.error,
              })),
            },
          }
        }),
      )
      .handle(
        "session.status",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const snapshot = yield* native.value.snapshot({ sessionID: ctx.params.sessionID, ...placement })
            return {
              data:
                nativeExecution(snapshot).type === "running" ? { type: "busy" as const } : { type: "idle" as const },
            }
          }
          return {
            data: yield* session.status(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.children",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.children(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (native && placement) {
            const page = yield* native
              .history({
                ...placement,
                sessionID: ctx.params.sessionID,
                after: ctx.query.after ?? 0,
                limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
              })
              .pipe(Effect.orDie)
            const decode = Schema.decodeUnknownOption(Schema.toType(SessionEvent.Durable))
            return {
              data: page.events
                .map((event) => decode(event))
                .filter(Option.isSome)
                .map((event) => event.value),
              hasMore: page.hasMore,
            }
          }
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn(function* (ctx) {
          const native = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Service))
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (native && placement)
            return nativeSessionEvents(native, {
              ...placement,
              sessionID: ctx.params.sessionID,
              after: ctx.query.after ?? 0,
            }).pipe(Stream.orDie)
          return session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie)
        }),
      )
      .handle(
        "session.execution",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const snapshot = yield* native.value.snapshot({ sessionID: ctx.params.sessionID, ...placement })
            return nativeExecution(snapshot)
          }
          const executionID = (yield* session.executions).get(ctx.params.sessionID)
          return executionID ? { type: "running" as const, executionID } : { type: "idle" as const }
        }),
      )
      .handle(
        "session.interruptIf",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            const interrupted = yield* native.value.interruptIf({
              sessionID: ctx.params.sessionID,
              executionID: ctx.params.executionID,
              ...placement,
            })
            if (!interrupted)
              return yield* new ConflictError({
                message: "Session execution changed or is no longer active",
                resource: ctx.params.sessionID,
              })
            return HttpApiSchema.NoContent.make()
          }
          const interrupted = yield* Effect.uninterruptible(
            session.interruptIf(ctx.params.sessionID, ctx.params.executionID),
          )
          if (!interrupted)
            return yield* new ConflictError({
              message: "Session execution changed or is no longer active",
              resource: ctx.params.sessionID,
            })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          const native = yield* Effect.serviceOption(NativeEngine.Service)
          const placement = Option.getOrUndefined(yield* Effect.serviceOption(NativeEngine.Placement))
          if (Option.isSome(native) && placement) {
            yield* native.value.interrupt({ sessionID: ctx.params.sessionID, ...placement })
            return HttpApiSchema.NoContent.make()
          }
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)
