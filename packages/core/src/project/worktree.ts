export * as ProjectWorktree from "./worktree"

import path from "path"
import { eq, like, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Event as DirectoriesEvent } from "@miao/schema/project-directories"
import { WorktreeEvent } from "@miao/schema/worktree-event"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { GitCli } from "../git-cli"
import { Global } from "../global"
import { AppProcess } from "../process"
import { Project } from "../project"
import { AbsolutePath } from "../schema"
import { Slug } from "../util/slug"
import { ProjectDirectories } from "./directories"
import { ProjectMetadata } from "./metadata"
import { ProjectTable } from "./sql"
import { SessionTable } from "../session/sql"

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree.Info" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "Worktree.CreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const DirectoryInput = Schema.Struct({ directory: Schema.String }).annotate({
  identifier: "Worktree.DirectoryInput",
})
export type DirectoryInput = Schema.Schema.Type<typeof DirectoryInput>

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()("ProjectWorktree.Error", {
  message: Schema.String,
}) {}

/** The project a worktree operation acts on, as the requesting location resolved it. */
export interface Target {
  readonly projectID: Project.ID
  /** The checkout the request came from; git commands run here. */
  readonly checkout: string
  readonly git: boolean
}

export interface Interface {
  /** Creates a worktree on a fresh `miao/<name>` branch and returns at once; files, events and start scripts follow. */
  readonly create: (target: Target, input?: CreateInput) => Effect.Effect<Info, WorktreeError>
  /** Picks a unique worktree name and directory without touching git; `detached` omits the branch. */
  readonly prepare: (
    target: Target,
    options?: { readonly name?: string; readonly detached?: boolean },
  ) => Effect.Effect<Info, WorktreeError>
  /** Creates a worktree at a prepared name/directory and returns at once; files, events and start scripts follow. */
  readonly createFromInfo: (target: Target, info: Info, startCommand?: string) => Effect.Effect<void, WorktreeError>
  /** Lists secondary worktrees of the checkout, excluding the primary one. */
  readonly list: (target: Target) => Effect.Effect<Info[], WorktreeError>
  readonly remove: (target: Target, input: DirectoryInput) => Effect.Effect<boolean, WorktreeError>
  /** Resets a secondary worktree to the default branch, removing every local change. */
  readonly reset: (target: Target, input: DirectoryInput) => Effect.Effect<boolean, WorktreeError>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ProjectWorktree") {}

const MAX_NAME_ATTEMPTS = 26

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Background work outlives the request and any one location, so it runs in the service's scope.
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const process = yield* AppProcess.Service
    const cli = yield* GitCli.Service
    const global = yield* Global.Service
    const events = yield* EventV2.Service
    const directories = yield* ProjectDirectories.Service
    const { db } = yield* Database.Service

    const git = (args: string[], cwd: string) =>
      cli.run(args, { cwd }).pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          text: result.text(),
          stderr: result.stderr.toString("utf8"),
        })),
      )

    const expect = Effect.fnUntraced(function* (args: string[], cwd: string, failure: string) {
      const result = yield* git(args, cwd)
      if (result.code !== 0) return yield* new WorktreeError({ message: result.stderr || result.text || failure })
      return result
    })

    const requireGit = (target: Target) =>
      target.git
        ? Effect.void
        : Effect.fail(new WorktreeError({ message: "Worktrees are only supported for git projects" }))

    const canonical = Effect.fnUntraced(function* (input: string) {
      const real = yield* fs.realPath(path.resolve(input)).pipe(Effect.catch(() => Effect.succeed(path.resolve(input))))
      const normalized = path.normalize(real)
      return globalThis.process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    const locate = Effect.fnUntraced(function* (checkout: string, directory: string) {
      const listed = yield* expect(["worktree", "list", "--porcelain"], checkout, "Failed to read git worktrees")
      for (const entry of parseWorktreeList(listed.text)) {
        if (entry.path && (yield* canonical(entry.path)) === directory) return entry
      }
      return undefined
    })

    const candidate = Effect.fnUntraced(function* (
      target: Target,
      root: string,
      name?: string,
      detached?: boolean,
    ) {
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, index) => index)) {
        const next = name ? (attempt === 0 ? name : `${name}-${Slug.create()}`) : Slug.create()
        const directory = path.join(root, next)
        if (yield* fs.existsSafe(directory)) continue
        const branch = detached ? undefined : `miao/${next}`
        if (
          branch &&
          (yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], target.checkout)).code === 0
        )
          continue
        return { name: next, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new WorktreeError({ message: "Failed to generate a unique worktree name" })
    })

    const record = Effect.fnUntraced(function* (projectID: Project.ID, directory: string, present: boolean) {
      const absolute = AbsolutePath.make(FSUtil.resolve(directory))
      yield* present
        ? directories.create({ projectID, directory: absolute, strategy: "git_worktree" })
        : directories.remove({ projectID, directory: absolute })
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      if (row) {
        const others = row.sandboxes.filter((sandbox) => sandbox !== absolute)
        yield* db
          .update(ProjectTable)
          .set({ sandboxes: present ? [...others, absolute] : others, time_updated: Date.now() })
          .where(eq(ProjectTable.id, projectID))
          .run()
          .pipe(Effect.orDie)
      }
      yield* events.publish(DirectoriesEvent.Updated, { projectID })
    })

    const runStartScript = Effect.fnUntraced(function* (directory: string, command: string, kind: string) {
      const text = command.trim()
      if (!text) return true
      const [shell, args] = globalThis.process.platform === "win32" ? ["cmd", ["/c", text]] : ["bash", ["-lc", text]]
      const result = yield* process
        .run(ChildProcess.make(shell, args, { cwd: directory, extendEnv: true, stdin: "ignore" }))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (result?.exitCode === 0) return true
      yield* Effect.logError("worktree start command failed", {
        kind,
        directory,
        message: result?.stderr.toString("utf8") ?? "",
      })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (directory: string, projectID: Project.ID, extra?: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      const start = row ? ProjectMetadata.fromRow(row).commands?.start : undefined
      if (!(yield* runStartScript(directory, start ?? "", "project"))) return
      yield* runStartScript(directory, extra ?? "", "worktree")
    })

    const failed = (directory: string, message: string) =>
      Effect.gen(function* () {
        yield* Effect.logError("worktree checkout failed", { directory, message })
        yield* events.publish(
          WorktreeEvent.Failed,
          { message },
          { location: { directory: AbsolutePath.make(directory) } },
        )
      })

    const prepare = Effect.fn("ProjectWorktree.prepare")(function* (
      target: Target,
      options?: { readonly name?: string; readonly detached?: boolean },
    ) {
      yield* requireGit(target)
      const root = path.join(global.data, "worktree", target.projectID)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      return yield* candidate(target, root, options?.name ? slugify(options.name) : undefined, options?.detached)
    })

    const createFromInfo = Effect.fn("ProjectWorktree.createFromInfo")(function* (
      target: Target,
      info: Info,
      startCommand?: string,
    ) {
      yield* requireGit(target)
      yield* expect(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        target.checkout,
        "Failed to create git worktree",
      )
      // Report the resolved path, the form directory listings and location events use for it.
      const resolved = { ...info, directory: FSUtil.resolve(info.directory) }
      yield* record(target.projectID, resolved.directory, true)

      yield* Effect.gen(function* () {
        const populated = yield* git(["reset", "--hard"], resolved.directory)
        if (populated.code !== 0)
          return yield* failed(
            resolved.directory,
            populated.stderr || populated.text || "Failed to populate worktree",
          )
        yield* events.publish(
          WorktreeEvent.Ready,
          { name: resolved.name, ...(resolved.branch ? { branch: resolved.branch } : {}) },
          { location: { directory: AbsolutePath.make(resolved.directory) } },
        )
        yield* runStartScripts(resolved.directory, target.projectID, startCommand)
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

    const create = Effect.fn("ProjectWorktree.create")(function* (target: Target, input?: CreateInput) {
      const picked = yield* prepare(target, { name: input?.name })
      yield* createFromInfo(target, picked, input?.startCommand)
      return { ...picked, directory: FSUtil.resolve(picked.directory) }
    })

    const list = Effect.fn("ProjectWorktree.list")(function* (target: Target) {
      yield* requireGit(target)
      const result = yield* expect(["worktree", "list", "--porcelain"], target.checkout, "Failed to read git worktrees")
      const primary = yield* canonical(target.checkout)
      const primaryName = path.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = path.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? path.basename(path.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item): item is Info => item !== undefined)))
    })

    const remove = Effect.fn("ProjectWorktree.remove")(function* (target: Target, input: DirectoryInput) {
      yield* requireGit(target)
      const directory = yield* canonical(input.directory)
      // Deleting a worktree whose directory still anchors sessions leaves them
      // with a dead cwd: tools, snapshots, and every later resume fail. Refuse
      // while any session row still points into the tree, even when git has
      // already forgotten the worktree registration.
      const living = yield* db
        .select({ id: SessionTable.id, title: SessionTable.title })
        .from(SessionTable)
        .where(or(eq(SessionTable.directory, directory), like(SessionTable.directory, `${directory}/%`)))
        .all()
        .pipe(Effect.orDie)
      if (living.length > 0)
        return yield* new WorktreeError({
          message:
            `Cannot remove the worktree at "${directory}": ${living.length} session(s) still live in it ` +
            `(${living.map((session) => `${session.id} "${session.title}"`).join(", ")}). ` +
            "Move them out with exit_worktree or delete the sessions first.",
        })
      const entry = yield* locate(target.checkout, directory)
      if (!entry?.path) {
        if (yield* fs.existsSafe(directory)) {
          yield* stopFsmonitor(directory)
          yield* cleanDirectory(directory)
        }
        yield* record(target.projectID, input.directory, false)
        return true
      }

      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], target.checkout)
      // git can fail to remove a worktree it has already forgotten; that still counts as removed.
      if (removed.code !== 0 && (yield* locate(target.checkout, directory))?.path)
        return yield* new WorktreeError({ message: removed.stderr || removed.text || "Failed to remove git worktree" })
      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) yield* expect(["branch", "-D", branch], target.checkout, "Failed to delete worktree branch")
      yield* record(target.projectID, entry.path, false)
      return true
    })

    const reset = Effect.fn("ProjectWorktree.reset")(function* (target: Target, input: DirectoryInput) {
      yield* requireGit(target)
      const directory = yield* canonical(input.directory)
      if (directory === (yield* canonical(target.checkout)))
        return yield* new WorktreeError({ message: "Cannot reset the primary workspace" })
      const entry = yield* locate(target.checkout, directory)
      if (!entry?.path) return yield* new WorktreeError({ message: "Worktree not found" })
      const worktree = entry.path

      const base = yield* cli.defaultBranch(target.checkout)
      if (!base) return yield* new WorktreeError({ message: "Default branch not found" })
      const separator = base.ref.indexOf("/")
      if (base.ref !== base.name && separator > 0)
        yield* expect(
          ["fetch", base.ref.slice(0, separator), base.ref.slice(separator + 1)],
          target.checkout,
          `Failed to fetch ${base.ref}`,
        )
      yield* expect(["reset", "--hard", base.ref], worktree, "Failed to reset worktree to target")
      const cleaned = yield* sweep(worktree)
      if (cleaned.code !== 0)
        return yield* new WorktreeError({ message: cleaned.stderr || cleaned.text || "Failed to clean worktree" })
      yield* expect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        worktree,
        "Failed to update submodules",
      )
      yield* expect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        worktree,
        "Failed to reset submodules",
      )
      yield* expect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        worktree,
        "Failed to clean submodules",
      )
      const status = yield* expect(
        ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"],
        worktree,
        "Failed to read git status",
      )
      if (status.text.trim())
        return yield* new WorktreeError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })

      yield* runStartScripts(worktree, target.projectID).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )
      return true
    })

    const stopFsmonitor = (target: string) =>
      fs
        .existsSafe(target)
        .pipe(Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], target) : Effect.void)))

    const cleanDirectory = (target: string) =>
      Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          // Windows releases file handles late, so retry the removal for a while there.
          const attempts = globalThis.process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new WorktreeError({
            message: error instanceof Error ? error.message : "Failed to remove git worktree directory",
          }),
      })

    // `git clean` stops at entries it cannot remove; delete those inside the worktree and try once more.
    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], root)
      if (first.code === 0) return first
      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(path.resolve(root, entry))
            if (target === base || !target.startsWith(`${base}${path.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
      return yield* git(["clean", "-ffdx"], root)
    })

    return Service.of({ create, prepare, createFromInfo, list, remove, reset })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, AppProcess.node, GitCli.node, Global.node, EventV2.node, ProjectDirectories.node, Database.node],
})

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function parseWorktreeList(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .reduce<{ path?: string; branch?: string }[]>((entries, line) => {
      if (line.startsWith("worktree ")) return [...entries, { path: line.slice("worktree ".length).trim() }]
      const current = entries.at(-1)
      if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim()
      return entries
    }, [])
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const value = line
          .match(/^warning:\s+failed to remove\s+(.+):\s+/i)?.[1]
          ?.trim()
          .replace(/^['"]|['"]$/g, "")
        return value ? [value] : []
      }),
  )
}
