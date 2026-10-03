export * as ProjectWorktree from "./worktree"

import path from "path"
import { eq } from "drizzle-orm"
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
      cli
        .run(args, { cwd })
        .pipe(
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

    const candidate = Effect.fnUntraced(function* (target: Target, root: string, name?: string) {
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, index) => index)) {
        const next = name ? (attempt === 0 ? name : `${name}-${Slug.create()}`) : Slug.create()
        const directory = path.join(root, next)
        if (yield* fs.existsSafe(directory)) continue
        const branch = `miao/${next}`
        if ((yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], target.checkout)).code === 0)
          continue
        return { name: next, directory, branch }
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

    const create = Effect.fn("ProjectWorktree.create")(function* (target: Target, input?: CreateInput) {
      yield* requireGit(target)
      const root = path.join(global.data, "worktree", target.projectID)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      const picked = yield* candidate(target, root, input?.name ? slugify(input.name) : undefined)
      yield* expect(
        ["worktree", "add", "--no-checkout", "-b", picked.branch, picked.directory],
        target.checkout,
        "Failed to create git worktree",
      )
      // Report the resolved path, the form directory listings and location events use for it.
      const info = { ...picked, directory: FSUtil.resolve(picked.directory) }
      yield* record(target.projectID, info.directory, true)

      yield* Effect.gen(function* () {
        const populated = yield* git(["reset", "--hard"], info.directory)
        if (populated.code !== 0)
          return yield* failed(info.directory, populated.stderr || populated.text || "Failed to populate worktree")
        yield* events.publish(
          WorktreeEvent.Ready,
          { name: info.name, branch: info.branch },
          { location: { directory: AbsolutePath.make(info.directory) } },
        )
        yield* runStartScripts(info.directory, target.projectID, input?.startCommand)
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
      return info
    })

    const remove = Effect.fn("ProjectWorktree.remove")(function* (target: Target, input: DirectoryInput) {
      yield* requireGit(target)
      const directory = yield* canonical(input.directory)
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

    return Service.of({ create, remove, reset })
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
