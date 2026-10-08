import { execFile, spawn } from "node:child_process"
import { readFile, rm, stat } from "node:fs/promises"
import { platform, release, tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

function command(command: string, args: string[] = [], input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
    const output: Buffer[] = []
    child.on("error", reject)
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(output))
      reject(new Error(`${command} exited with code ${code}`))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function writeOsc52(text: string) {
  if (!process.stdout.isTTY) return
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
  const passthrough = `\x1bPtmux;\x1b${sequence}\x1b\\`
  process.stdout.write(process.env.TMUX ? sequence + passthrough : process.env.STY ? passthrough : sequence)
}

/**
 * The pasteboard already carries the image as `public.png`; AppleScript's
 * `the clipboard as "PNGf"` instead makes the pasteboard server renegotiate
 * and re-encode it, which costs about a second on every paste. Read the bytes
 * directly and only convert the TIFF representation a screenshot leaves behind.
 */
function macImageScript(file: string) {
  return `ObjC.import("AppKit")
const pasteboard = $.NSPasteboard.generalPasteboard
let image = pasteboard.dataForType("public.png")
if (image.isNil()) {
  const tiff = pasteboard.dataForType("public.tiff")
  if (tiff.isNil()) throw new Error("clipboard holds no image")
  image = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
}
if (image.isNil()) throw new Error("could not encode the clipboard image")
image.writeToFileAtomically(${JSON.stringify(file)}, true)`
}

// The mtty host writes an image paste here (ADR 0036) right before it sends
// the empty bracketed paste that leads to a clipboard read, so a TUI does not
// need osascript to reach the macOS pasteboard. Serve the file only while it
// is fresh and consume it after reading: an empty paste that did not come from
// the host writer (Windows Terminal surfaces an image-only clipboard that way)
// would otherwise re-serve the previous paste forever, which showed up as
// every paste attaching the same old screenshot.
const HOST_CLIPBOARD_MAX_AGE_MS = 10_000

export async function readHostClipboardImage(hostFile: string | undefined) {
  if (!hostFile) return undefined
  const info = await stat(hostFile).catch(() => undefined)
  if (!info) return undefined
  if (Date.now() - info.mtimeMs > HOST_CLIPBOARD_MAX_AGE_MS) {
    await rm(hostFile, { force: true }).catch(() => {})
    return undefined
  }
  const data = await readFile(hostFile).catch(() => undefined)
  await rm(hostFile, { force: true }).catch(() => {})
  if (data?.length) return { data: data.toString("base64"), mime: "image/png" }
  return undefined
}

export async function read() {
  const hosted = await readHostClipboardImage(process.env.MTTY_CLIPBOARD_FILE)
  if (hosted) return hosted

  if (platform() === "darwin") {
    const file = path.join(tmpdir(), "miao-clipboard.png")
    try {
      await exec("osascript", ["-l", "JavaScript", "-e", macImageScript(file)])
      return { data: (await readFile(file)).toString("base64"), mime: "image/png" }
    } catch {
      // Fall through to text clipboard.
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }

  if (platform() === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const image = await command("powershell.exe", ["-NonInteractive", "-NoProfile", "-command", script]).catch(() =>
      Buffer.alloc(0),
    )
    if (image.length) return { data: image.toString().trim(), mime: "image/png" }
  }

  if (platform() === "linux") {
    const wayland = await command("wl-paste", ["-t", "image/png"]).catch(() => Buffer.alloc(0))
    if (wayland.length) return { data: wayland.toString("base64"), mime: "image/png" }
    const x11 = await command("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]).catch(() =>
      Buffer.alloc(0),
    )
    if (x11.length) return { data: x11.toString("base64"), mime: "image/png" }
  }

  const { default: clipboardy } = await import("clipboardy")
  const text = await clipboardy.read().catch(() => undefined)
  if (text) return { data: text, mime: "text/plain" }
}

export function copyCommand(
  os: NodeJS.Platform,
  wayland: boolean,
  has: (name: string) => boolean,
): string[] | undefined {
  if (os === "darwin" && has("osascript")) return ["osascript"]
  if (os === "linux" && wayland && has("wl-copy")) return ["wl-copy"]
  if (os === "linux" && has("xclip")) return ["xclip", "-selection", "clipboard"]
  if (os === "linux" && has("xsel")) return ["xsel", "--clipboard", "--input"]
  if (os === "win32" && has("powershell.exe")) {
    return [
      "powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ]
  }
}

let copyMethod: Promise<(text: string) => Promise<void>> | undefined

function getCopyMethod() {
  return (copyMethod ??= (async () => {
    const { which } = await import("@miao/core/util/which")
    const native = copyCommand(platform(), Boolean(process.env.WAYLAND_DISPLAY), (name) => Boolean(which(name)))
    if (native?.[0] === "osascript") {
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await command("osascript", ["-e", `set the clipboard to "${escaped}"`]).catch(() => undefined)
      }
    }
    if (native) {
      return async (text: string) => {
        await command(native[0], native.slice(1), text).catch(() => undefined)
      }
    }
    return async (text: string) => {
      const { default: clipboardy } = await import("clipboardy")
      await clipboardy.write(text).catch(() => undefined)
    }
  })())
}

export async function write(text: string) {
  writeOsc52(text)
  const method = await getCopyMethod()
  await method(text)
}
