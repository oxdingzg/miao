import type { Node } from "web-tree-sitter"

export type Part = {
  type: string
  text: string
}

export type ExtractedCommand = {
  parts: Part[]
  tokens: string[]
  source: string
}

const KEPT = new Set(["command_name", "command_name_expr", "word", "string", "raw_string", "concatenation"])

/** Command name and argument parts, skipping separators and redirections. */
export function parts(node: Node): Part[] {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (!KEPT.has(child.type)) continue
    out.push({ type: child.type, text: child.text })
  }
  return out
}

/** Command text, widening to the whole redirected statement when applicable. */
export function source(node: Node): string {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

/** Every command in the tree, in document order, as parts/tokens/source. */
export function extract(root: Node): ExtractedCommand[] {
  return root
    .descendantsOfType("command")
    .filter((node): node is Node => Boolean(node))
    .map((node) => {
      const commandParts = parts(node)
      return { parts: commandParts, tokens: commandParts.map((part) => part.text), source: source(node) }
    })
}
