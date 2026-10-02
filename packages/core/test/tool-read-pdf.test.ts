import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { mkdtemp, rm } from "fs/promises"
import { Duration, Effect, Exit, PlatformError } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@miao/core/effect/layer-node"
import { AppProcess } from "@miao/core/process"
import { ReadToolPdf } from "@miao/core/tool/read-pdf"

type Call = { readonly command: string; readonly args: readonly string[]; readonly options?: AppProcess.RunOptions }

const result = (stdout: string | Buffer, exitCode = 0, stderr = ""): AppProcess.RunResult => ({
  command: "fake",
  exitCode,
  stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
  stderr: Buffer.from(stderr),
  stdoutTruncated: false,
  stderrTruncated: false,
})

/**
 * A fake poppler over an in-memory document: `null` pages have no text layer.
 * Renders are fake JPEG bytes naming the page so tests can tell them apart.
 */
const poppler = (pages: ReadonlyArray<string | null>) => {
  const calls: Call[] = []
  const run: ReadToolPdf.Run = (command, options) => {
    const standard = command as ChildProcess.StandardCommand
    const call = { command: standard.command, args: standard.args, options }
    calls.push(call)
    const flag = (name: string) => Number(call.args[call.args.indexOf(name) + 1])
    if (call.command === "pdfinfo" && !call.args.includes("-f"))
      return Effect.succeed(result(`Title:          fixture\nPages:          ${pages.length}\nEncrypted:      no\n`))
    if (call.command === "pdfinfo")
      return Effect.succeed(
        result(
          Array.from({ length: flag("-l") - flag("-f") + 1 }, (_, index) => {
            const page = flag("-f") + index
            return `Page ${String(page).padStart(4)} size: 612 x 792 pts (letter)\nPage ${String(page).padStart(4)} rot:  0\n`
          }).join(""),
        ),
      )
    if (call.command === "pdftotext")
      return Effect.succeed(
        result(
          pages
            .slice(flag("-f") - 1, flag("-l"))
            .map((text) => `${text ?? ""}\n\f`)
            .join(""),
        ),
      )
    if (call.command === "pdftoppm")
      return Effect.succeed(result(Buffer.from(`\xff\xd8\xff page ${flag("-f")}`, "latin1")))
    return Effect.die(`unexpected command ${call.command}`)
  }
  return { calls, pdf: ReadToolPdf.make(run) }
}

const words = (page: number) => `Page ${page} has a real text layer with enough characters.`
const read = (pdf: ReadToolPdf.Interface, input: ReadToolPdf.ReadInput = {}) =>
  Effect.runPromise(pdf.read("/docs/file.pdf", "file.pdf", input))
const fail = async (pdf: ReadToolPdf.Interface, input: ReadToolPdf.ReadInput = {}) => {
  const exit = await Effect.runPromiseExit(pdf.read("/docs/file.pdf", "file.pdf", input))
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (!error || error._tag !== "Fail") throw new Error("expected a typed failure")
  return error.error
}

describe("ReadToolPdf.parsePages", () => {
  const parse = (spec: string, total: number) => Effect.runPromise(ReadToolPdf.parsePages(spec, total))
  const parseError = (spec: string, total: number) =>
    Effect.runPromise(ReadToolPdf.parsePages(spec, total).pipe(Effect.flip)).then((error) => error.message)

  test("parses single pages, ranges, and lists into sorted unique pages", async () => {
    expect(await parse("3", 10)).toEqual([3])
    expect(await parse("1-5", 10)).toEqual([1, 2, 3, 4, 5])
    expect(await parse("1,3,7-9", 10)).toEqual([1, 3, 7, 8, 9])
    expect(await parse(" 9 , 2-3 ,2 ", 10)).toEqual([2, 3, 9])
  })

  test("rejects malformed, reversed, zero, out-of-range, and oversized selections", async () => {
    expect(await parseError("abc", 10)).toContain('use 1-based page numbers and ranges such as "3", "1-5"')
    expect(await parseError("", 10)).toContain("use 1-based page numbers")
    expect(await parseError("1,,2", 10)).toContain("use 1-based page numbers")
    expect(await parseError("0", 10)).toContain("page numbers start at 1")
    expect(await parseError("5-3", 10)).toContain("range 5-3 ends before it starts")
    expect(await parseError("1-11", 10)).toContain("page 11 is out of range; this PDF has 10 pages")
    expect(await parseError("2", 1)).toContain("this PDF has 1 page.")
    expect(await parseError("1-21", 30)).toContain(`requests 21 pages; read at most ${ReadToolPdf.MAX_PAGES}`)
  })

  test("formats page lists compactly", () => {
    expect(ReadToolPdf.formatPages([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8")
    expect(ReadToolPdf.formatPages([4])).toBe("4")
  })
})

describe("ReadToolPdf.read", () => {
  test("returns page-labelled text for a PDF with a text layer", async () => {
    const fake = poppler([words(1), words(2), words(3)])

    const pages = await read(fake.pdf)

    expect(pages).toMatchObject({ type: "pdf-pages", totalPages: 3, pages: [1, 2, 3], images: [], truncated: false })
    expect(pages.next).toBeUndefined()
    expect(pages.content).toBe(
      [
        "PDF file.pdf: 3 pages. Returned pages 1-3.",
        `--- Page 1 ---\n${words(1)}`,
        `--- Page 2 ---\n${words(2)}`,
        `--- Page 3 ---\n${words(3)}`,
      ].join("\n\n"),
    )
    expect(fake.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["pdfinfo", "/docs/file.pdf"],
      ["pdftotext", "-layout", "-enc", "UTF-8", "-f", "1", "-l", "3", "/docs/file.pdf", "-"],
    ])
    expect(fake.calls[0]?.options?.timeout).toEqual(ReadToolPdf.INFO_TIMEOUT)
  })

  test("renders scanned pages to JPEG images and says the model capability is unknown", async () => {
    const fake = poppler([null, "  \n x \n"])

    const pages = await read(fake.pdf)

    expect(pages.pages).toEqual([1, 2])
    expect(pages.images).toEqual([
      { page: 1, mime: "image/jpeg", content: Buffer.from("\xff\xd8\xff page 1", "latin1").toString("base64") },
      { page: 2, mime: "image/jpeg", content: Buffer.from("\xff\xd8\xff page 2", "latin1").toString("base64") },
    ])
    expect(pages.content).toContain("--- Page 1: no text layer (scanned or image-only); rendered as an image below ---")
    expect(pages.content).toContain("--- Page 2: no text layer")
    expect(pages.content).toContain("cannot confirm that the current model accepts image input")
    const renders = fake.calls.filter((call) => call.command === "pdftoppm")
    expect(renders.map((call) => call.args)).toEqual([
      ["-r", "120", "-jpeg", "-jpegopt", "quality=85", "-f", "1", "-l", "1", "-singlefile", "/docs/file.pdf"],
      ["-r", "120", "-jpeg", "-jpegopt", "quality=85", "-f", "2", "-l", "2", "-singlefile", "/docs/file.pdf"],
    ])
  })

  test("omits the capability caveat when the model is known to accept images", async () => {
    const pages = await read(poppler([null]).pdf, { images: true })

    expect(pages.images).toHaveLength(1)
    expect(pages.content).not.toContain("cannot confirm")
  })

  test("returns text for text pages and images for scanned pages of a mixed document", async () => {
    const fake = poppler([words(1), null, words(3)])

    const pages = await read(fake.pdf, { pages: "1-3" })

    expect(pages.pages).toEqual([1, 2, 3])
    expect(pages.images.map((image) => image.page)).toEqual([2])
    expect(pages.content).toContain(`--- Page 1 ---\n${words(1)}`)
    expect(pages.content).toContain("--- Page 2: no text layer (scanned or image-only); rendered as an image below ---")
    expect(pages.content).toContain(`--- Page 3 ---\n${words(3)}`)
  })

  test("reads only the requested pages", async () => {
    const fake = poppler(Array.from({ length: 12 }, (_, index) => words(index + 1)))

    const pages = await read(fake.pdf, { pages: "2,4-5,12" })

    expect(pages.pages).toEqual([2, 4, 5, 12])
    expect(pages.truncated).toBe(false)
    expect(pages.content).not.toContain("Not yet read")
    expect(fake.calls.filter((call) => call.command === "pdftotext").map((call) => call.args.slice(3, 7))).toEqual([
      ["-f", "2", "-l", "2"],
      ["-f", "4", "-l", "5"],
      ["-f", "12", "-l", "12"],
    ])
  })

  test("reads the first pages by default and says how to continue", async () => {
    const fake = poppler(Array.from({ length: 25 }, (_, index) => words(index + 1)))

    const pages = await read(fake.pdf)

    expect(pages.pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(pages.truncated).toBe(true)
    expect(pages.next).toBe("11-25")
    expect(pages.content).toContain("PDF file.pdf: 25 pages. Returned pages 1-10.")
    expect(pages.content).toContain("No pages were specified, so only the first 10 of 25 pages were read.")
    expect(pages.content).toContain('Not yet read: pages 11-25. Continue with pages="11-25"')
  })

  test("caps page renders per call and points at the rest", async () => {
    const fake = poppler([null, null, words(3), null, null, null, null, null])

    const pages = await read(fake.pdf, { pages: "1-8" })

    expect(pages.images.map((image) => image.page)).toEqual([1, 2, 4, 5, 6])
    expect(pages.pages).toEqual([1, 2, 3, 4, 5, 6])
    expect(pages.next).toBe("7-8")
    expect(pages.content).toContain(
      `Pages 7-8 have no text layer and were not rendered in this call (at most ${ReadToolPdf.MAX_RENDERED_PAGES} page images per call).`,
    )
    expect(pages.content).toContain('Continue with pages="7-8"')
    expect(fake.calls.filter((call) => call.command === "pdftoppm")).toHaveLength(ReadToolPdf.MAX_RENDERED_PAGES)
  })

  test("fails clearly instead of returning empty text when the model cannot see scanned pages", async () => {
    const fake = poppler([null, null])

    const error = await fail(fake.pdf, { images: false })

    expect(error).toBeInstanceOf(ReadToolPdf.UnreadableError)
    expect(error.message).toBe(
      "PDF file.pdf (2 pages): pages 1-2 have no text layer (scanned or image-only), and the current model does not accept image input, so their content could not be read. Switch to a model with image input to read these pages.",
    )
    expect(fake.calls.some((call) => call.command === "pdftoppm")).toBe(false)
  })

  test("marks scanned pages as unread for a text-only model while returning text pages", async () => {
    const fake = poppler([words(1), null])

    const pages = await read(fake.pdf, { images: false })

    expect(pages.pages).toEqual([1])
    expect(pages.images).toEqual([])
    expect(pages.content).toContain("--- Page 2: no text layer (scanned or image-only); not readable")
    expect(pages.content).toContain(
      "Pages 2 have no text layer (scanned or image-only) and the current model does not accept image input, so their content was NOT read.",
    )
  })

  test("stops at the read size limit on a page boundary", async () => {
    const big = (page: number) => `${words(page)}\n${"x".repeat(30 * 1024)}`
    const fake = poppler([big(1), big(2), big(3)])

    const pages = await read(fake.pdf)

    expect(pages.pages).toEqual([1])
    expect(pages.next).toBe("2-3")
    expect(pages.content).toContain("Output reached the read size limit (50 KB / 2000 lines) after page 1.")
    expect(Buffer.byteLength(pages.content)).toBeLessThanOrEqual(50 * 1024)
  })

  test("cuts a single page larger than the read size limit and says so", async () => {
    const fake = poppler([`${words(1)}\n${"y".repeat(100)}\n`.repeat(1000), words(2)])

    const pages = await read(fake.pdf)

    expect(pages.pages).toEqual([1])
    expect(pages.next).toBe("2")
    expect(pages.content).toContain("Page 1 alone exceeds the read output limit")
    expect(Buffer.byteLength(pages.content)).toBeLessThanOrEqual(50 * 1024)
  })

  test("reports a missing poppler install with install hints", async () => {
    const error = await fail(
      ReadToolPdf.make(() =>
        Effect.fail(
          new AppProcess.AppProcessError({
            command: "pdfinfo /docs/file.pdf",
            cause: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "pdfinfo /docs/file.pdf",
            }),
          }),
        ),
      ),
    )

    expect(error).toBeInstanceOf(ReadToolPdf.DependencyError)
    expect(error.message).toContain("`pdfinfo` was not found on PATH")
    expect(error.message).toContain("brew install poppler")
    expect(error.message).toContain("sudo apt install poppler-utils")
    expect(error.message).toContain("Windows")
  })

  test("reports a timed-out command", async () => {
    const error = await fail(
      ReadToolPdf.make(() =>
        Effect.fail(new AppProcess.AppProcessError({ command: "pdfinfo", cause: new Error("Timed out") })),
      ),
    )

    expect(error).toBeInstanceOf(ReadToolPdf.CommandError)
    expect(error.message).toBe(
      `Unable to read PDF file.pdf: pdfinfo timed out after ${Duration.format(ReadToolPdf.INFO_TIMEOUT)}`,
    )
  })

  test("reports a failing command with its stderr", async () => {
    const error = await fail(
      ReadToolPdf.make(() => Effect.succeed(result("", 1, "Command Line Error: Incorrect password\n"))),
    )

    expect(error.message).toBe(
      "Unable to read PDF file.pdf: pdfinfo exited with code 1: Command Line Error: Incorrect password",
    )
  })

  test("rejects a pages selection beyond the document", async () => {
    const error = await fail(poppler([words(1), words(2)]).pdf, { pages: "3" })

    expect(error).toBeInstanceOf(ReadToolPdf.PagesError)
    expect(error.message).toContain("page 3 is out of range; this PDF has 2 pages")
  })

  test("falls back to per-page extraction when page separators do not line up", async () => {
    const calls: string[][] = []
    const pdf = ReadToolPdf.make((command) => {
      const standard = command as ChildProcess.StandardCommand
      calls.push([standard.command, ...standard.args])
      if (standard.command === "pdfinfo") return Effect.succeed(result("Pages: 2\n"))
      const first = standard.args[standard.args.indexOf("-f") + 1]
      const last = standard.args[standard.args.indexOf("-l") + 1]
      // A multi-page run without separators cannot be split per page.
      if (first !== last) return Effect.succeed(result(`${words(1)} ${words(2)}`))
      return Effect.succeed(result(`${words(Number(first))}\n\f`))
    })

    const pages = await read(pdf)

    expect(pages.content).toContain(`--- Page 1 ---\n${words(1)}`)
    expect(pages.content).toContain(`--- Page 2 ---\n${words(2)}`)
    expect(calls.filter((call) => call[0] === "pdftotext")).toHaveLength(3)
  })
})

const hasPoppler = ["pdfinfo", "pdftotext", "pdftoppm"].every((command) => Bun.which(command) !== null)

/** Builds a two-page PDF: page 1 has a text layer, page 2 is a filled rectangle with no text. */
const fixturePdf = () => {
  const streams: Record<number, string> = {
    4: "BT /F1 24 Tf 72 700 Td (Hello from the text layer) Tj ET",
    6: "0 0 1 rg 72 72 468 648 re f",
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${streams[4]!.length} >>\nstream\n${streams[4]}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
    `<< /Length ${streams[6]!.length} >>\nstream\n${streams[6]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const body = objects.reduce(
    (acc, object, index) => {
      acc.offsets.push(acc.text.length)
      acc.text += `${index + 1} 0 obj\n${object}\nendobj\n`
      return acc
    },
    { text: "%PDF-1.4\n", offsets: [] as number[] },
  )
  return [
    body.text,
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...body.offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.text.length}\n%%EOF\n`,
  ].join("")
}

describe.skipIf(!hasPoppler)("ReadToolPdf with poppler", () => {
  test("extracts the text page and renders the image-only page", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "miao-read-pdf-"))
    try {
      const file = path.join(directory, "fixture.pdf")
      await Bun.write(file, fixturePdf())

      const pages = await Effect.gen(function* () {
        const pdf = yield* ReadToolPdf.Service
        return yield* pdf.read(file, "fixture.pdf", {})
      }).pipe(Effect.provide(LayerNode.compile(ReadToolPdf.node)), Effect.runPromise)

      expect(pages.totalPages).toBe(2)
      expect(pages.pages).toEqual([1, 2])
      expect(pages.content).toContain("--- Page 1 ---\nHello from the text layer")
      expect(pages.content).toContain("--- Page 2: no text layer")
      expect(pages.images.map((image) => [image.page, image.mime])).toEqual([[2, "image/jpeg"]])
      expect(Buffer.from(pages.images[0]!.content, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test("reports a missing executable as a dependency error through AppProcess", async () => {
  const error = await Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const pdf = ReadToolPdf.make((command, options) => {
      const standard = command as ChildProcess.StandardCommand
      return appProcess.run(ChildProcess.make("miao-missing-pdfinfo-binary", standard.args, standard.options), options)
    })
    return yield* pdf.read("/missing.pdf", "missing.pdf", {}).pipe(Effect.flip)
  }).pipe(Effect.provide(LayerNode.compile(AppProcess.node)), Effect.runPromise)

  expect(error).toBeInstanceOf(ReadToolPdf.DependencyError)
  expect(error.message).toContain("`pdfinfo` was not found on PATH")
})
