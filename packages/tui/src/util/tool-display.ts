const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "execute",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

// `edit` and `write` both report committed `FileDiff.Info` counts, so they share
// one summary; `read` counts the page the tool actually returned.
export function fileToolSummary(tool: "read" | "edit" | "write", metadata: Record<string, unknown>) {
  if (tool === "read") {
    if (Array.isArray(metadata.entries)) {
      const count = metadata.entries.length
      return `Read ${count} ${count === 1 ? "entry" : "entries"}${metadata.truncated ? " (truncated)" : ""}`
    }
    if (metadata.encoding === "base64" && typeof metadata.mime === "string" && metadata.mime.startsWith("image/"))
      return "Read image"
    if (typeof metadata.content !== "string" || metadata.encoding === "base64") return
    const count = metadata.content === "" ? 0 : metadata.content.replace(/\r?\n$/, "").split("\n").length
    return `Read ${count} ${count === 1 ? "line" : "lines"}${metadata.truncated ? " (truncated)" : ""}`
  }
  if (!Array.isArray(metadata.files)) return
  const counts = metadata.files.flatMap((file) => {
    if (!file || typeof file !== "object") return []
    if (!("additions" in file) || !("deletions" in file)) return []
    if (typeof file.additions !== "number" || typeof file.deletions !== "number") return []
    if (!Number.isFinite(file.additions) || !Number.isFinite(file.deletions)) return []
    return [{ added: file.additions, removed: file.deletions }]
  })
  if (counts.length === 0) return
  const added = counts.reduce((sum, count) => sum + count.added, 0)
  const removed = counts.reduce((sum, count) => sum + count.removed, 0)
  return (
    [
      added > 0 ? `Added ${added} ${added === 1 ? "line" : "lines"}` : undefined,
      removed > 0 ? `${added > 0 ? "removed" : "Removed"} ${removed} ${removed === 1 ? "line" : "lines"}` : undefined,
    ]
      .filter(Boolean)
      .join(", ") || "No line changes"
  )
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}
