// Converts between ACP content blocks and V2 prompt input / user messages.
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ContentBlock, ContentChunk } from "@agentclientprotocol/sdk"

export type PromptFile = { readonly uri: string; readonly name?: string }
export type Prompt = { readonly text: string; readonly files?: ReadonlyArray<PromptFile> }
export type UserFile = { readonly uri: string; readonly mime: string; readonly name?: string }

type Piece = { readonly text?: string; readonly file?: PromptFile }

/** Builds one V2 prompt: text blocks join as paragraphs, attachments become prompt files. */
export function promptFromContent(blocks: ReadonlyArray<ContentBlock>): Prompt {
  const pieces = blocks.flatMap(blockPieces)
  const files = pieces.flatMap((piece) => (piece.file ? [piece.file] : []))
  return {
    text: pieces.flatMap((piece) => (piece.text === undefined ? [] : [piece.text])).join("\n\n"),
    ...(files.length > 0 ? { files } : {}),
  }
}

/** A leading `/name args` in the prompt text, if any. */
export function slashCommand(prompt: Prompt) {
  const text = prompt.text.trim()
  if (!text.startsWith("/")) return undefined
  const [name, ...rest] = text.slice(1).split(/\s+/)
  if (!name) return undefined
  return { name, args: rest.join(" ").trim() }
}

export function userContent(message: { readonly text: string; readonly files?: ReadonlyArray<UserFile> }) {
  const files = (message.files ?? []).flatMap(fileChunks)
  return [...(message.text ? [{ content: { type: "text" as const, text: message.text } }] : []), ...files]
}

function blockPieces(block: ContentBlock): Piece[] {
  switch (block.type) {
    case "text":
      // Text meant only for the user is never shown to the model.
      if (block.annotations?.audience?.length === 1 && block.annotations.audience[0] === "user") return []
      return [{ text: block.text }]
    case "image": {
      const name = fileName(block.uri ?? undefined) ?? "image"
      if (block.data) return [{ file: { uri: `data:${block.mimeType};base64,${block.data}`, name } }]
      if (block.uri && /^(data:|https?:\/\/)/.test(block.uri)) return [{ file: { uri: block.uri, name } }]
      return []
    }
    case "resource_link":
      return [linkPiece(block.uri, block.name)]
    case "resource": {
      const resource = block.resource
      if ("text" in resource) return [{ text: `[${resourceLabel(resource.uri)}]\n${resource.text}` }]
      if (!resource.mimeType) return []
      return [
        {
          file: {
            uri: resource.uri.startsWith("data:") ? resource.uri : `data:${resource.mimeType};base64,${resource.blob}`,
            name: fileName(resource.uri) ?? "file",
          },
        },
      ]
    }
    default:
      return []
  }
}

function linkPiece(uri: string, name: string | undefined): Piece {
  if (uri.startsWith("file://")) return { file: { uri, name: name ?? fileName(uri) ?? "file" } }
  // Zed links project files as zed://...?path=<absolute path>.
  const zedPath = uri.startsWith("zed://") && URL.canParse(uri) ? new URL(uri).searchParams.get("path") : null
  if (zedPath) return { file: { uri: pathToFileURL(zedPath).href, name: name ?? (path.basename(zedPath) || "file") } }
  return { text: uri }
}

/** `path:line` for file URIs (Zed encodes the line as `#L<n>`), the raw URI otherwise. */
function resourceLabel(uri: string) {
  if (!uri.startsWith("file:") || !URL.canParse(uri)) return uri
  const url = new URL(uri)
  const line = url.hash.match(/^#L(\d+)/)?.[1]
  const file = filePathOf(url).replaceAll("\\", "/")
  return line ? `${file}:${line}` : file
}

function filePathOf(url: URL) {
  // fileURLToPath rejects some URLs (for example a host on POSIX); the decoded pathname is the fallback.
  const host = url.hostname
  if (host && host !== "localhost") return decodeURIComponent(url.pathname)
  return fileURLToPath(url)
}

function fileChunks(file: UserFile): ContentChunk[] {
  if (file.uri.startsWith("data:")) {
    const data = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s.exec(file.uri)
    const mime = data?.[1] ?? file.mime
    if (!data) return []
    const uri = pathToFileURL(file.name ?? "file").href
    if (mime.startsWith("image/")) return [{ content: { type: "image", mimeType: mime, data: data[2], uri } }]
    if (mime.startsWith("text/") || mime === "application/json")
      return [
        {
          content: {
            type: "resource",
            resource: { uri, mimeType: mime, text: Buffer.from(data[2], "base64").toString("utf8") },
          },
        },
      ]
    return [{ content: { type: "resource", resource: { uri, mimeType: mime, blob: data[2] } } }]
  }
  return [
    {
      content: {
        type: "resource_link",
        uri: file.uri,
        name: file.name ?? fileName(file.uri) ?? "file",
        mimeType: file.mime,
      },
    },
  ]
}

function fileName(uri: string | undefined) {
  if (!uri || uri.startsWith("data:")) return undefined
  if (!URL.canParse(uri)) return path.basename(uri) || undefined
  return path.basename(new URL(uri).pathname) || undefined
}
