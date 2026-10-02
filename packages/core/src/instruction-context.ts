export * as InstructionContext from "./instruction-context"

import { Array, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { basename, dirname, isAbsolute, join, relative, sep } from "path"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

// `path` is an absolute file path, or the URL of a configured remote instruction.
export class File extends Schema.Class<File>("InstructionContext.File")({
  path: Schema.String,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

// Remote instructions are observed on every provider turn. Cache them so an
// unreachable URL neither delays each turn nor flips the context epoch between
// "present" and "absent"; a failed refresh keeps the last good content.
const REMOTE_REFRESH_MS = 5 * 60 * 1000
const REMOTE_RETRY_MS = 60 * 1000
const REMOTE_TIMEOUT = "5 seconds"

export interface Interface {
  /**
   * Returns instruction files between `path` and the Location directory that
   * ambient context does not already carry and that this Session has not been
   * given yet. The read tool attaches them, like V1's nested discovery.
   */
  readonly nearby: (input: { readonly sessionID: string; readonly path: string }) => Effect.Effect<ReadonlyArray<File>>
}

export class Service extends Context.Service<Service, Interface>()("@miao/v2/InstructionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const config = yield* Config.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const remote = new Map<string, { readonly content?: string; readonly checked: number }>()
    // Nested instruction files already attached per Session. V1 derived this
    // from earlier read results in history; process memory is enough here
    // because a repeat after restart only costs one duplicate attachment.
    const claims = new Map<string, Set<string>>()

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const names = () => ["AGENTS.md", ...(Flag.MIAO_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]), "CONTEXT.md"]

    /**
     * Resolves ambient instruction sources in V1 order, deduplicated by first occurrence:
     * 1. the first existing global file: `<config>/AGENTS.md`, then `~/.claude/CLAUDE.md`;
     * 2. project files from the Location directory up to the project root, using only the
     *    first file name (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) found anywhere on that
     *    path so different conventions from different ancestors never stack;
     * 3. local `instructions` config entries (globs, absolute paths, `~/` paths);
     * 4. `instructions` URLs, rendered last.
     */
    const sources = Effect.fn("InstructionContext.sources")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const [globalFile] = yield* Effect.filter(
        [
          join(global.config, "AGENTS.md"),
          ...(Flag.MIAO_DISABLE_CLAUDE_CODE_PROMPT ? [] : [join(global.home, ".claude", "CLAUDE.md")]),
        ],
        (file) => fs.existsSafe(file),
      )
      const candidates =
        Flag.MIAO_DISABLE_PROJECT_CONFIG || !insideProject ? [] : yield* fs.up({ targets: names(), start, stop })
      const winner = names().find((name) => candidates.some((item) => basename(item) === name))
      const discovered = new Set(
        yield* Effect.forEach(
          candidates.filter((item) => basename(item) === winner),
          fs.resolve,
        ),
      )
      const instructions = Array.dedupe(
        (yield* config.entries()).flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : [])),
      )
      const configured = yield* Effect.forEach(
        instructions.filter((item) => !isUrl(item)),
        (raw) => {
          const instruction = raw.startsWith("~/") ? join(global.home, raw.slice(2)) : raw
          if (isAbsolute(instruction))
            return fs.glob(basename(instruction), { cwd: dirname(instruction), absolute: true, include: "file" })
          if (Flag.MIAO_DISABLE_PROJECT_CONFIG) return fs.globUp(instruction, global.config, global.config)
          return fs.globUp(instruction, start, insideProject ? stop : start)
        },
      ).pipe(
        // Glob order follows the filesystem, which differs across platforms. Sort
        // so the rendered instructions (and the cached prompt prefix) are stable:
        // deeper paths first keeps globUp's nearer-directory-first order.
        Effect.map((matches) =>
          matches.flatMap((items) =>
            items.toSorted((a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b)),
          ),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )
      const paths = Array.dedupe(
        yield* Effect.forEach([...(globalFile ? [globalFile] : []), ...discovered, ...configured], fs.resolve),
      )
      return { paths, discovered, urls: instructions.filter(isUrl) }
    })

    const fetchRemote = Effect.fn("InstructionContext.fetchRemote")(function* (url: string) {
      const now = Date.now()
      const cached = remote.get(url)
      if (cached && now - cached.checked < (cached.content === undefined ? REMOTE_RETRY_MS : REMOTE_REFRESH_MS))
        return cached.content
      const fetched = yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((response) => response.text),
        Effect.timeout(REMOTE_TIMEOUT),
        Effect.catch((error) =>
          Effect.logWarning("failed to fetch instructions", { url, error }).pipe(Effect.as(undefined)),
        ),
      )
      const content = fetched || cached?.content
      remote.set(url, { content, checked: now })
      return content
    })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const resolved = yield* sources()
      const files = yield* Effect.forEach(
        resolved.paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(Effect.map((content) => (content === undefined ? undefined : new File({ path, content })))),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && resolved.discovered.has(resolved.paths[index])))
        return SystemContext.unavailable
      const urls = yield* Effect.forEach(
        resolved.urls,
        (url) =>
          fetchRemote(url).pipe(Effect.map((content) => (content ? new File({ path: url, content }) : undefined))),
        { concurrency: 4 },
      )
      return [...files, ...urls].filter((file): file is File => file !== undefined)
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })

    const nearby = Effect.fn("InstructionContext.nearby")(function* (input: {
      readonly sessionID: string
      readonly path: string
    }) {
      const root = yield* fs.resolve(location.directory)
      const target = yield* fs.resolve(input.path)
      const ambient = new Set(
        yield* sources().pipe(
          Effect.map((resolved) => resolved.paths),
          Effect.catch(() => Effect.succeed([] as string[])),
        ),
      )
      const claimed = claims.get(input.sessionID) ?? new Set<string>()
      claims.set(input.sessionID, claimed)
      const found = yield* Effect.forEach(ancestors(dirname(target), root), (directory) =>
        Effect.filter(
          names().map((name) => join(directory, name)),
          (file) => fs.existsSafe(file),
        ).pipe(Effect.map((matches) => matches[0])),
      )
      const fresh = found.filter(
        (file): file is string =>
          file !== undefined && file !== target && !ambient.has(file) && !claimed.has(file),
      )
      fresh.forEach((file) => claimed.add(file))
      const files = yield* Effect.forEach(fresh, (path) =>
        fs.readFileStringSafe(path).pipe(Effect.map((content) => (content ? new File({ path, content }) : undefined))),
      )
      return files.filter((file): file is File => file !== undefined)
    }, Effect.catch(() => Effect.succeed([] as File[])))

    return Service.of({ nearby })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node, Config.node, httpClient],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

function isUrl(item: string) {
  return item.startsWith("https://") || item.startsWith("http://")
}

// Directories from `start` up to, but excluding, `root`; empty when `start` is outside `root`.
function ancestors(start: string, root: string): string[] {
  const fromRoot = relative(root, start)
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return []
  return [start, ...ancestors(dirname(start), root)]
}
