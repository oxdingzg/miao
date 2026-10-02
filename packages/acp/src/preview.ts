// Reconstructs the file contents an edit permission request would produce, so
// the client can show a diff and preview the new text before it is written.
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { applyPatch } from "diff"

export type FileChange = { readonly path: string; readonly oldText: string; readonly newText: string }

/**
 * Edit requests carry `{ filepath, diff }` (edit, write) or `{ files: [{ file, patch, status }] }`
 * (apply_patch). Changes that cannot be reconstructed are left out.
 */
export async function editChanges(metadata: Readonly<Record<string, unknown>>, cwd: string): Promise<FileChange[]> {
  const files = Array.isArray(metadata.files) ? metadata.files.flatMap(patchFile) : []
  if (files.length > 0) {
    const changes = await Promise.all(
      files.map(async (file) => {
        const path = isAbsolute(file.file) ? file.file : resolve(cwd, file.file)
        const oldText = file.status === "added" ? "" : await read(path)
        if (file.status === "deleted") return [{ path, oldText, newText: "" }]
        const newText = applyPatch(oldText, file.patch)
        return newText === false ? [] : [{ path, oldText, newText }]
      }),
    )
    return changes.flat()
  }
  const filepath = typeof metadata.filepath === "string" ? metadata.filepath : undefined
  const diff = typeof metadata.diff === "string" ? metadata.diff : undefined
  if (!filepath || !diff) return []
  const path = isAbsolute(filepath) ? filepath : resolve(cwd, filepath)
  const oldText = await read(path)
  const newText = applyIndented(oldText, diff)
  return newText === undefined ? [] : [{ path, oldText, newText }]
}

/**
 * Applies a prompt diff. Prompt diffs drop the indentation every changed or
 * context line shares, so when the diff does not apply as is, the shared
 * indentation is recovered from the file and restored before retrying.
 */
export function applyIndented(source: string, diff: string) {
  const direct = applyPatch(source, diff)
  if (direct !== false) return direct
  const lines = diff.split("\n")
  // A context or removed line exists in the file, so it shows how much indentation was dropped.
  const anchor = lines.find((line) => isBody(line) && !line.startsWith("+") && line.slice(1).trim().length > 0)
  if (!anchor) return undefined
  const content = anchor.slice(1)
  const prefixes = new Set(
    source
      .split(/\r?\n/)
      .filter((line) => line.endsWith(content) && /^\s+$/.test(line.slice(0, line.length - content.length)))
      .map((line) => line.slice(0, line.length - content.length)),
  )
  for (const prefix of prefixes) {
    const restored = lines
      .map((line) => (isBody(line) && line.slice(1).trim().length > 0 ? line[0] + prefix + line.slice(1) : line))
      .join("\n")
    const result = applyPatch(source, restored, {
      compareLine: (_line, current, _operation, patch) => current.trimEnd() === patch.trimEnd(),
    })
    if (result !== false) return result
  }
  return undefined
}

function isBody(line: string) {
  return (
    (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
    !line.startsWith("+++") &&
    !line.startsWith("---")
  )
}

function patchFile(value: unknown) {
  if (!value || typeof value !== "object") return []
  const file = value as Record<string, unknown>
  if (typeof file.file !== "string" || typeof file.patch !== "string") return []
  return [{ file: file.file, patch: file.patch, status: typeof file.status === "string" ? file.status : "modified" }]
}

function read(path: string) {
  return readFile(path, "utf8")
    .then((text) => text.replace(/^﻿/, ""))
    .catch(() => "")
}
