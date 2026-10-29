import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { println } from "../ui"

/// Where the Core `knowledge` tool persists workspace memory, relative to the
/// workspace root. This command is read-only: it renders the same document the
/// tool writes, without invoking the model.
const STORE = ".miao/knowledge.json"

/** One stored note, as the knowledge store persists it. */
interface Note {
  readonly title?: string
  readonly kind?: string
  readonly body?: string
  readonly derivation?: string
  readonly updated_at_ms?: number
  readonly expires_at_ms?: number | null
  readonly sources?: ReadonlyArray<{ readonly path: string }>
}

/** The version-1 knowledge document. */
interface Document {
  readonly revision?: number
  readonly notes?: Readonly<Record<string, Note>>
}

const stamp = (ms: number | undefined) =>
  ms === undefined ? "" : new Date(ms).toISOString().slice(0, 19).replace("T", " ")

const expiry = (note: Note, now: number) => {
  if (note.expires_at_ms == null) return ""
  return note.expires_at_ms <= now ? " (expired)" : ` (expires ${stamp(note.expires_at_ms)})`
}

/** A read-only listing of every stored note. Pure so it is unit-testable. */
export const renderList = (document: Document, now: number): string => {
  const notes = Object.entries(document.notes ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (notes.length === 0) return "No memory notes stored."
  const width = Math.max(...notes.map(([id]) => id.length))
  return [
    `${notes.length} note(s), store revision ${document.revision ?? 0}:`,
    ...notes.map(([id, note]) => {
      const sources = note.sources?.length ?? 0
      return `  ${id.padEnd(width)}  ${note.kind ?? "-"}  ${note.title ?? ""}${expiry(note, now)}  [${sources} source(s)]`
    }),
  ].join("\n")
}

/** A read-only detail view of one note, or `undefined` when it is absent. */
export const renderDetail = (document: Document, id: string, now: number): string | undefined => {
  const note = document.notes?.[id]
  if (note === undefined) return undefined
  const sources = (note.sources ?? []).map((source) => `  - ${source.path}`)
  return [
    `${id} (${note.kind ?? "-"})${expiry(note, now)}`,
    `  title:   ${note.title ?? ""}`,
    `  stored:  ${stamp(note.updated_at_ms)}`,
    ...(note.derivation ? [`  derived: ${note.derivation}`] : []),
    ...(sources.length > 0 ? ["  sources:", ...sources] : []),
    "",
    note.body ?? "",
  ].join("\n")
}

export const MemoryCommand = effectCmd({
  command: "memory [id]",
  describe: `review stored workspace memory (${STORE}) without invoking the model`,
  builder: (yargs) => yargs.positional("id", { type: "string", describe: "show one note's full detail" }),
  handler: Effect.fn("Cli.memory")(function* ({ id }) {
    const store = path.join(process.cwd(), STORE)
    const text = yield* Effect.tryPromise({
      try: () => fs.readFile(store, "utf8"),
      catch: () => new Error(`no memory store at ${STORE}; the knowledge tool creates it on first note`),
    }).pipe(Effect.mapError((error) => new CliError({ message: error.message })))
    const document = yield* Effect.try({
      try: () => JSON.parse(text) as Document,
      catch: () => new Error(`${STORE} is not valid JSON; it was left untouched for review`),
    }).pipe(Effect.mapError((error) => new CliError({ message: error.message })))
    if (id !== undefined) {
      const detail = renderDetail(document, id, Date.now())
      if (detail === undefined) return yield* fail(`No memory note "${id}" in ${STORE}`)
      println(detail)
      return
    }
    println(renderList(document, Date.now()))
  }),
})
