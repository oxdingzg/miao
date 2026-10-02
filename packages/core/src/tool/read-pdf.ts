export * as ReadToolPdf from "./read-pdf"

import { Context, Duration, Effect, Layer, PlatformError, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { PositiveInt } from "../schema"
import { MAX_READ_BYTES, MAX_READ_LINES } from "./read-filesystem"

/** Pages read when the caller does not pass `pages`. */
export const DEFAULT_PAGES = 10
/** Most pages one call may request. */
export const MAX_PAGES = 20
/** Most pages rendered to images in one call; the rest are reported for a follow-up call. */
export const MAX_RENDERED_PAGES = 5
/**
 * A page whose extracted text has fewer non-whitespace characters than this is
 * treated as having no usable text layer (scanned, image-only, or blank) and is
 * rendered instead. Judged per page, so mixed documents get text and images.
 */
export const MIN_TEXT_CHARS = 16
export const RENDER_DPI = 120
/** Longest rendered side; matches the `Image.normalize` default `max_width`/`max_height`. */
export const MAX_RENDER_PIXELS = 2_000
export const INFO_TIMEOUT = Duration.seconds(20)
export const TEXT_TIMEOUT = Duration.seconds(60)
export const RENDER_TIMEOUT = Duration.seconds(60)
const MAX_TEXT_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_OUTPUT_BYTES = 32 * 1024 * 1024
// Leaves room in the read size limit for the header and continuation notes.
const SECTION_BYTES = MAX_READ_BYTES - 2 * 1024
const SECTION_LINES = MAX_READ_LINES - 40

export class DependencyError extends Schema.TaggedErrorClass<DependencyError>()("ReadToolPdf.DependencyError", {
  command: Schema.String,
}) {
  override get message() {
    return [
      `Reading PDF files requires poppler (pdfinfo, pdftotext, pdftoppm), but \`${this.command}\` was not found on PATH.`,
      "Install it, then retry:",
      "- macOS: brew install poppler",
      "- Debian/Ubuntu: sudo apt install poppler-utils",
      "- Fedora/RHEL: sudo dnf install poppler-utils",
      "- Windows: scoop install poppler (or choco install poppler), and make sure its bin directory is on PATH",
    ].join("\n")
  }
}

export class CommandError extends Schema.TaggedErrorClass<CommandError>()("ReadToolPdf.CommandError", {
  command: Schema.String,
  resource: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Unable to read PDF ${this.resource}: ${this.command} ${this.reason}`
  }
}

export class PagesError extends Schema.TaggedErrorClass<PagesError>()("ReadToolPdf.PagesError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export class UnreadableError extends Schema.TaggedErrorClass<UnreadableError>()("ReadToolPdf.UnreadableError", {
  resource: Schema.String,
  pages: Schema.String,
  totalPages: Schema.Number,
}) {
  override get message() {
    return `PDF ${this.resource} (${this.totalPages} pages): pages ${this.pages} have no text layer (scanned or image-only), and the current model does not accept image input, so their content could not be read. Switch to a model with image input to read these pages.`
  }
}

export type Error = DependencyError | CommandError | PagesError | UnreadableError

export const Image = Schema.Struct({ page: PositiveInt, mime: Schema.String, content: Schema.String })
export type Image = typeof Image.Type

export class Pages extends Schema.Class<Pages>("ReadTool.PdfPages")({
  type: Schema.Literal("pdf-pages"),
  /** Page-labelled text plus notes about rendered, skipped, and remaining pages. */
  content: Schema.String,
  totalPages: PositiveInt,
  /** Pages whose content is returned, as text or as an image. */
  pages: Schema.Array(PositiveInt),
  /** Base64 page renders for pages without a text layer. */
  images: Schema.Array(Image),
  truncated: Schema.Boolean,
  /** A `pages` value that continues with the pages not returned by this call. */
  next: Schema.String.pipe(Schema.optional),
}) {}

export interface ReadInput {
  readonly pages?: string
  /**
   * Whether the current model accepts image input. `undefined` means unknown:
   * pages are rendered and the result says so, so a text-only model is not
   * left believing it read them.
   */
  readonly images?: boolean
}

export interface Interface {
  readonly read: (file: string, resource: string, input: ReadInput) => Effect.Effect<Pages, Error>
}

export class Service extends Context.Service<Service, Interface>()("@miao/ReadToolPdf") {}

/** The process runner seam; production uses `AppProcess.run`, tests inject a fake. */
export type Run = AppProcess.Interface["run"]

export const make = (run: Run): Interface => ({
  read: Effect.fn("ReadToolPdf.read")(function* (file: string, resource: string, input: ReadInput) {
    const exec = (command: string, args: string[], timeout: Duration.Duration, maxOutputBytes: number) =>
      execute(run, resource, command, args, timeout, maxOutputBytes)
    const total = parsePageCount((yield* exec("pdfinfo", [file], INFO_TIMEOUT, 1024 * 1024)).toString("utf8"))
    if (total === undefined)
      return yield* new CommandError({ command: "pdfinfo", resource, reason: "did not report a page count" })
    const requested =
      input.pages === undefined ? range(1, Math.min(DEFAULT_PAGES, total)) : yield* parsePages(input.pages, total)
    const texts = yield* extractText(exec, file, requested)
    const plan = planPages(requested, texts, input.images)
    if (plan.returned.length === 0 && plan.unreadable.length > 0)
      return yield* new UnreadableError({ resource, pages: formatPages(plan.unreadable), totalPages: total })
    const images = yield* renderPages(exec, file, plan.rendered)
    const remaining = [
      ...plan.deferred,
      ...(input.pages === undefined && total > DEFAULT_PAGES ? range(DEFAULT_PAGES + 1, total) : []),
    ]
    const next = remaining.length === 0 ? undefined : formatPages(remaining.slice(0, MAX_PAGES))
    return new Pages({
      type: "pdf-pages",
      content: [
        `PDF ${resource}: ${total} page${total === 1 ? "" : "s"}. Returned page${plan.returned.length === 1 ? "" : "s"} ${formatPages(plan.returned)}.`,
        ...plan.sections,
        ...notes({ total, input, plan, remaining, next }),
      ].join("\n\n"),
      totalPages: total,
      pages: plan.returned,
      images,
      truncated: remaining.length > 0,
      ...(next === undefined ? {} : { next }),
    })
  }),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    return Service.of(make(appProcess.run))
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node] })

/**
 * Parses a 1-based page selection such as `3`, `1-5`, or `1,3,7-9` against
 * the document's page count. Returns sorted unique page numbers.
 */
export const parsePages = (spec: string, total: number) =>
  Effect.gen(function* () {
    const parts = spec.split(",").map((part) => part.trim())
    const ranges: Array<readonly [number, number]> = []
    for (const part of parts) {
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
      if (!match)
        return yield* new PagesError({
          reason: `Invalid pages "${spec}": use 1-based page numbers and ranges such as "3", "1-5", or "1,3,7-9".`,
        })
      const first = Number(match[1])
      const last = match[2] === undefined ? first : Number(match[2])
      if (first < 1) return yield* new PagesError({ reason: `Invalid pages "${spec}": page numbers start at 1.` })
      if (last < first)
        return yield* new PagesError({ reason: `Invalid pages "${spec}": range ${part} ends before it starts.` })
      if (last > total)
        return yield* new PagesError({
          reason: `Invalid pages "${spec}": page ${last} is out of range; this PDF has ${total} page${total === 1 ? "" : "s"}.`,
        })
      ranges.push([first, last])
    }
    const pages = [...new Set(ranges.flatMap(([first, last]) => range(first, last)))].sort((a, b) => a - b)
    if (pages.length > MAX_PAGES)
      return yield* new PagesError({
        reason: `Invalid pages "${spec}": requests ${pages.length} pages; read at most ${MAX_PAGES} pages per call.`,
      })
    return pages
  })

/** Formats sorted page numbers as a compact `pages` value, for example `1-3,5`. */
export const formatPages = (pages: ReadonlyArray<number>) =>
  pages
    .reduce<Array<[number, number]>>((runs, page) => {
      const last = runs.at(-1)
      if (last && page === last[1] + 1) last[1] = page
      else runs.push([page, page])
      return runs
    }, [])
    .map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`))
    .join(",")

const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index)

const parsePageCount = (info: string) => {
  const match = /^Pages:\s+(\d+)\s*$/m.exec(info)
  const count = match ? Number(match[1]) : 0
  return count > 0 ? count : undefined
}

const execute = (
  run: Run,
  resource: string,
  command: string,
  args: string[],
  timeout: Duration.Duration,
  maxOutputBytes: number,
) =>
  run(ChildProcess.make(command, args, { stdin: "ignore" }), { timeout, maxOutputBytes, maxErrorBytes: 4 * 1024 }).pipe(
    Effect.catchTag("AppProcessError", (error): Effect.Effect<never, DependencyError | CommandError> => {
      if (error.cause instanceof PlatformError.PlatformError && error.cause.reason._tag === "NotFound")
        return Effect.fail(new DependencyError({ command }))
      if (error.cause instanceof globalThis.Error && error.cause.message === "Timed out")
        return Effect.fail(
          new CommandError({ command, resource, reason: `timed out after ${Duration.format(timeout)}` }),
        )
      return Effect.fail(new CommandError({ command, resource, reason: `could not run: ${error.message}` }))
    }),
    Effect.flatMap((result) => {
      if (result.exitCode !== 0)
        return Effect.fail(
          new CommandError({
            command,
            resource,
            reason: `exited with code ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr.toString("utf8").trim()}` : ""}`,
          }),
        )
      if (result.stdoutTruncated)
        return Effect.fail(
          new CommandError({ command, resource, reason: `produced more than ${maxOutputBytes} bytes of output` }),
        )
      return Effect.succeed(result.stdout)
    }),
  )

type Exec = (
  command: string,
  args: string[],
  timeout: Duration.Duration,
  maxOutputBytes: number,
) => Effect.Effect<Buffer, DependencyError | CommandError>

/** Extracts layout text per page, one pdftotext run per contiguous page run. */
const extractText = (exec: Exec, file: string, pages: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const texts = new Map<number, string>()
    for (const run of contiguous(pages)) {
      const first = run[0]!
      const last = run.at(-1)!
      const chunks = yield* extractRun(exec, file, first, last)
      // pdftotext ends every page with a form feed; a mismatched count means the
      // split cannot be trusted, so fall back to one run per page.
      if (chunks.length === run.length) {
        run.forEach((page, index) => texts.set(page, chunks[index]!))
        continue
      }
      for (const page of run) texts.set(page, (yield* extractRun(exec, file, page, page)).join("\n"))
    }
    return texts
  })

const extractRun = (exec: Exec, file: string, first: number, last: number) =>
  exec(
    "pdftotext",
    ["-layout", "-enc", "UTF-8", "-f", `${first}`, "-l", `${last}`, file, "-"],
    TEXT_TIMEOUT,
    MAX_TEXT_OUTPUT_BYTES,
  ).pipe(
    Effect.map((stdout) => {
      const chunks = new TextDecoder("utf-8").decode(stdout).split("\f")
      return chunks.at(-1)?.trim() === "" ? chunks.slice(0, -1) : chunks
    }),
  )

const contiguous = (pages: ReadonlyArray<number>) =>
  pages.reduce<number[][]>((runs, page) => {
    const last = runs.at(-1)
    if (last && page === last.at(-1)! + 1) last.push(page)
    else runs.push([page])
    return runs
  }, [])

const textChars = (text: string) => text.replace(/\s/g, "").length

type Plan = {
  sections: string[]
  returned: number[]
  rendered: number[]
  /** Requested pages left for a follow-up call (size limit or render cap). */
  deferred: number[]
  unreadable: number[]
  /** Page whose own text exceeded the size limit and was cut. */
  cut?: number
  /** Page after which the size limit stopped the read. */
  stoppedAfter?: number
}

/**
 * Decides, in page order, which pages fit in the read size limit and which
 * text-less pages are rendered, deferred, or unreadable.
 */
const planPages = (pages: ReadonlyArray<number>, texts: ReadonlyMap<number, string>, images: boolean | undefined) => {
  const plan: Plan = { sections: [], returned: [], rendered: [], deferred: [], unreadable: [] }
  let bytes = 0
  let lines = 0
  for (const page of pages) {
    if (plan.stoppedAfter !== undefined) {
      plan.deferred.push(page)
      continue
    }
    const text = (texts.get(page) ?? "").replace(/\s+$/, "")
    const scanned = textChars(text) < MIN_TEXT_CHARS
    if (scanned && images !== false && plan.rendered.length >= MAX_RENDERED_PAGES) {
      plan.deferred.push(page)
      continue
    }
    const section = !scanned
      ? `--- Page ${page} ---\n${text}`
      : images === false
        ? `--- Page ${page}: no text layer (scanned or image-only); not readable because the current model does not accept image input ---`
        : `--- Page ${page}: no text layer (scanned or image-only); rendered as an image below ---`
    const size = Buffer.byteLength(section, "utf-8") + 2
    const count = section.split("\n").length + 1
    if (bytes + size > SECTION_BYTES || lines + count > SECTION_LINES) {
      if (plan.returned.length > 0) {
        plan.stoppedAfter = plan.returned.at(-1)
        plan.deferred.push(page)
        continue
      }
      // A single page larger than the whole limit: return what fits and say so.
      plan.sections.push(truncate(section, SECTION_BYTES, SECTION_LINES))
      plan.returned.push(page)
      plan.cut = page
      plan.stoppedAfter = page
      continue
    }
    bytes += size
    lines += count
    plan.sections.push(section)
    if (scanned && images === false) {
      plan.unreadable.push(page)
      continue
    }
    plan.returned.push(page)
    if (scanned) plan.rendered.push(page)
  }
  return plan
}

const truncate = (text: string, maxBytes: number, maxLines: number) => {
  const lines = text.split("\n").slice(0, maxLines)
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf-8") + 1
    if (bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  return kept.join("\n")
}

const notes = (input: {
  readonly total: number
  readonly input: ReadInput
  readonly plan: Plan
  readonly remaining: ReadonlyArray<number>
  readonly next: string | undefined
}) => {
  const plan = input.plan
  const sizeLimit = `${MAX_READ_BYTES / 1024} KB / ${MAX_READ_LINES} lines`
  const renderDeferred = plan.deferred.filter((page) => plan.stoppedAfter === undefined || page < plan.stoppedAfter)
  return [
    plan.cut === undefined
      ? undefined
      : `Page ${plan.cut} alone exceeds the read output limit (${sizeLimit}); its text was cut and the rest of that page is not shown. To read all of it, extract it with \`pdftotext -layout -f ${plan.cut} -l ${plan.cut}\` into a text file and read that file with offset/limit.`,
    plan.stoppedAfter === undefined || plan.cut !== undefined
      ? undefined
      : `Output reached the read size limit (${sizeLimit}) after page ${plan.stoppedAfter}.`,
    renderDeferred.length === 0
      ? undefined
      : `Pages ${formatPages(renderDeferred)} have no text layer and were not rendered in this call (at most ${MAX_RENDERED_PAGES} page images per call).`,
    plan.unreadable.length === 0
      ? undefined
      : `Pages ${formatPages(plan.unreadable)} have no text layer (scanned or image-only) and the current model does not accept image input, so their content was NOT read. Switch to a model with image input to read them.`,
    plan.rendered.length === 0 || input.input.images !== undefined
      ? undefined
      : `Pages ${formatPages(plan.rendered)} have no text layer and are attached as page images (rendered at up to ${RENDER_DPI} DPI). The read tool cannot confirm that the current model accepts image input: if you cannot see these images, their content was not read; say so instead of guessing, and switch to a model with image input.`,
    input.input.pages === undefined && input.total > DEFAULT_PAGES
      ? `No pages were specified, so only the first ${DEFAULT_PAGES} of ${input.total} pages were read.`
      : undefined,
    input.remaining.length === 0
      ? undefined
      : `Not yet read: pages ${formatPages(input.remaining)}. Continue with pages="${input.next}" (at most ${MAX_PAGES} pages per call).`,
  ].filter((note) => note !== undefined)
}

/** Renders each page to JPEG within `MAX_RENDER_PIXELS` on its longest side. */
const renderPages = (exec: Exec, file: string, pages: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    if (pages.length === 0) return []
    const sizes = parsePageSizes(
      (yield* exec(
        "pdfinfo",
        ["-f", `${pages[0]}`, "-l", `${pages.at(-1)}`, file],
        INFO_TIMEOUT,
        4 * 1024 * 1024,
      )).toString("utf8"),
    )
    return yield* Effect.forEach(pages, (page) =>
      exec(
        "pdftoppm",
        [
          "-r",
          `${renderDpi(sizes.get(page))}`,
          "-jpeg",
          "-jpegopt",
          "quality=85",
          "-f",
          `${page}`,
          "-l",
          `${page}`,
          "-singlefile",
          file,
        ],
        RENDER_TIMEOUT,
        MAX_IMAGE_OUTPUT_BYTES,
      ).pipe(Effect.map((stdout) => ({ page, mime: "image/jpeg", content: stdout.toString("base64") }))),
    )
  })

const parsePageSizes = (info: string) =>
  new Map(
    [...info.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)].map(
      (match) => [Number(match[1]), Math.max(Number(match[2]), Number(match[3]))] as const,
    ),
  )

// Lower the DPI for large pages so the longest side stays within MAX_RENDER_PIXELS.
const renderDpi = (longestPoints: number | undefined) =>
  longestPoints === undefined || longestPoints <= 0
    ? RENDER_DPI
    : Math.max(1, Math.min(RENDER_DPI, Math.floor((MAX_RENDER_PIXELS * 72) / longestPoints)))
