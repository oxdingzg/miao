import { Effect } from "effect"
import { FileSystem } from "../filesystem"
import { base64Length, DecodeError, ResizerUnavailableError, SizeError, type Limits } from "../image"

// `Bun.Image` ships with the Bun runtime, but the `@types/bun` version this repo
// pins predates it, so the slice of its surface miao relies on is declared here
// and reached through a single cast at the runtime boundary. Delete this block
// once a `@types/bun` bump declares it.
interface BunImage {
  metadata(): Promise<{ readonly width?: number; readonly height?: number; readonly format?: string }>
  resize(
    width: number,
    height: number,
    options: { readonly fit: "inside"; readonly withoutEnlargement: boolean },
  ): BunImage
  jpeg(options: { readonly quality: number }): BunImage
  png(options: { readonly compressionLevel: number; readonly palette: boolean }): BunImage
  webp(options: { readonly quality: number }): BunImage
  toBuffer(): Promise<Uint8Array>
}

type BunImageConstructor = new (input: Uint8Array) => BunImage

/** Formats that cannot carry transparency, so the alpha probe can be skipped. */
const OPAQUE_FORMATS = new Set(["jpeg", "jpg", "bmp"])
const JPEG_QUALITIES = [80, 60, 40, 20]
const RESIZE_STEPS = 4
const RESIZE_FACTOR = 0.75
const LAST_RESORT_LONG_EDGE = 1_000
const VP8X_ALPHA_FLAG = 0x10
/** The probe only reads one bit, so it runs at the cheapest quality. */
const PROBE_QUALITY = 1
const PNG_PALETTE = { compressionLevel: 9, palette: true } as const

interface Source {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

interface Box {
  readonly width: number
  readonly height: number
}

interface Candidate {
  readonly bytes: Uint8Array
  readonly mime: string
}

interface Ladder {
  readonly mime: string
  readonly encode: (image: BunImage) => BunImage
}

export const available = () => constructor() !== undefined

const constructor = (): BunImageConstructor | undefined => {
  const candidate = (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image
  return typeof candidate === "function" ? (candidate as BunImageConstructor) : undefined
}

export const make = Effect.gen(function* () {
  const Image = constructor()
  if (Image === undefined) return yield* new ResizerUnavailableError()
  return Effect.fn("Image.Bun.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Limits,
  ) {
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: () => new DecodeError({ resource }) })

    const bytes = Buffer.from(content.content, "base64")
    const measured = yield* attempt(() => new Image(bytes).metadata())

    // A container miao cannot measure cannot be clamped either. Keep it when it
    // already fits the hard ceiling; otherwise there is nothing safe left to do.
    if (measured.width === undefined || measured.height === undefined)
      return bytes.length <= limits.maxRawBytes ? content : yield* new DecodeError({ resource })

    const source: Source = { bytes, width: measured.width, height: measured.height }
    const box = clamp(source, limits)
    const resized = box.width !== source.width || box.height !== source.height
    if (!resized && source.bytes.length <= limits.targetRawBytes) return content
    if (!limits.autoResize) {
      if (!resized && source.bytes.length <= limits.maxRawBytes) return content
      return yield* new SizeError({
        resource,
        width: source.width,
        height: source.height,
        bytes: base64Length(source.bytes.length),
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxBytes: limits.maxBase64Bytes,
      })
    }

    // JPEG cannot carry alpha, so only the formats that can need the probe.
    const alpha = OPAQUE_FORMATS.has(measured.format ?? "")
      ? false
      : yield* attempt(() => hasAlpha(Image, source, box))
    const ladders: ReadonlyArray<Ladder> = alpha
      ? [{ mime: "image/png", encode: (image) => image.png(PNG_PALETTE) }]
      : JPEG_QUALITIES.map((quality) => ({ mime: "image/jpeg", encode: (image: BunImage) => image.jpeg({ quality }) }))

    let smallest: Candidate | undefined
    for (const candidate of boxes(box)) {
      const encoded = yield* attempt(() => encodeAt(Image, source, candidate, ladders, limits.targetRawBytes))
      if (encoded.hit !== undefined) return reencode(content, encoded.hit)
      if (encoded.smallest !== undefined && (smallest === undefined || encoded.smallest.bytes.length < smallest.bytes.length))
        smallest = encoded.smallest
    }
    if (smallest !== undefined && smallest.bytes.length <= limits.maxRawBytes) return reencode(content, smallest)
    return yield* new SizeError({
      resource,
      width: source.width,
      height: source.height,
      bytes: base64Length(source.bytes.length),
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      maxBytes: limits.maxBase64Bytes,
    })
  })
})

/**
 * Transparency probe. Bun's WebP encoder only writes an extended `VP8X`
 * container, and only sets its alpha flag, when the decoded image really carries
 * transparency, so a plain `VP8 ` chunk means every pixel is opaque.
 *
 * Neither the dimensions nor the PNG colour type can answer this: 68% of the
 * screenshots measured in miao's own database are colour type 6 (RGBA-capable)
 * while being fully opaque, and asking the palette encoder instead costs ~770ms
 * per image because it quantises every pixel to 256 colours.
 */
const hasAlpha = async (Image: BunImageConstructor, source: Source, box: Box) => {
  const encoded = await handleAt(Image, source, box).webp({ quality: PROBE_QUALITY }).toBuffer()
  if (encoded.length < 21) return false
  if (Buffer.from(encoded.subarray(12, 16)).toString("latin1") !== "VP8X") return false
  return (encoded[20]! & VP8X_ALPHA_FLAG) !== 0
}

/** Encode one box, stopping at the first candidate that fits the target. */
const encodeAt = async (
  Image: BunImageConstructor,
  source: Source,
  box: Box,
  ladders: ReadonlyArray<Ladder>,
  targetRawBytes: number,
) => {
  const image = handleAt(Image, source, box)
  let smallest: Candidate | undefined
  for (const ladder of ladders) {
    const bytes = await ladder.encode(image).toBuffer()
    if (smallest === undefined || bytes.length < smallest.bytes.length) smallest = { bytes, mime: ladder.mime }
    if (bytes.length <= targetRawBytes) return { hit: { bytes, mime: ladder.mime } as Candidate, smallest }
  }
  return { hit: undefined, smallest }
}

const handleAt = (Image: BunImageConstructor, source: Source, box: Box) =>
  box.width === source.width && box.height === source.height
    ? new Image(source.bytes)
    : new Image(source.bytes).resize(box.width, box.height, { fit: "inside", withoutEnlargement: true })

const clamp = (source: Source, limits: Limits): Box => {
  const scale = Math.min(1, limits.maxWidth / source.width, limits.maxHeight / source.height)
  if (scale === 1) return { width: source.width, height: source.height }
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}

/** The clamped box, then progressive reductions, then Claude Code's 1000px floor. */
const boxes = (box: Box): ReadonlyArray<Box> => {
  const out: Array<Box> = [box]
  let current = box
  for (let step = 0; step < RESIZE_STEPS; step++) {
    const next = {
      width: Math.max(1, Math.floor(current.width * RESIZE_FACTOR)),
      height: Math.max(1, Math.floor(current.height * RESIZE_FACTOR)),
    }
    if (next.width === current.width && next.height === current.height) break
    out.push(next)
    current = next
  }
  const long = Math.max(box.width, box.height)
  if (long > LAST_RESORT_LONG_EDGE) {
    const scale = LAST_RESORT_LONG_EDGE / long
    out.push({
      width: Math.max(1, Math.round(box.width * scale)),
      height: Math.max(1, Math.round(box.height * scale)),
    })
  }
  return out
}

const reencode = (
  content: FileSystem.Content & { readonly encoding: "base64" },
  candidate: Candidate,
): FileSystem.Content & { readonly encoding: "base64" } => ({
  ...content,
  content: Buffer.from(candidate.bytes).toString("base64"),
  encoding: "base64",
  mime: candidate.mime,
})
