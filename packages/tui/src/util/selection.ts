import type { CliRenderer, Renderable } from "@opentui/core"
import type { ClipboardService } from "../context/clipboard"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  getClipboardText?: (text: string) => string
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string; selectedRenderables: FocusableSelectionTarget[] } | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
}

type TextSelectable = Renderable & { selectable?: boolean }

function resolveTextSelectable(target: Renderable | null): TextSelectable | undefined {
  let node: Renderable | null | undefined = target
  while (node) {
    const candidate = node as TextSelectable
    if (candidate.selectable && typeof candidate.x === "number" && typeof candidate.width === "number") return candidate
    node = node.parent
  }
  return undefined
}

function isWordChar(char: string | undefined) {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char)
}

function wordRange(text: string, index: number) {
  if (text.length === 0) return undefined
  const i = Math.max(0, Math.min(index, text.length - 1))
  if (!isWordChar(text[i])) return undefined
  let start = i
  while (start > 0 && isWordChar(text[start - 1])) start--
  let end = i + 1
  while (end < text.length && isWordChar(text[end])) end++
  return { start, end }
}

// Double-click word selection. opentui has no word-selection primitive, so we
// read the clicked visual row through the renderer selection, expand to word
// boundaries in cell space, then set the selection to that range. The existing
// copy-on-select path (mouse up) then copies the word.
export function selectWordAt(renderer: CliRenderer, target: Renderable | null, x: number, y: number): boolean {
  const node = resolveTextSelectable(target)
  if (!node || node.width <= 0) return false

  renderer.startSelection(node, node.x, y)
  renderer.updateSelection(node, node.x + node.width, y)
  const row = renderer.getSelection()?.getSelectedText()
  if (!row) return false

  const range = wordRange(row, x - node.x)
  if (!range) return false

  renderer.startSelection(node, node.x + range.start, y)
  renderer.updateSelection(node, node.x + range.end, y)
  return true
}

type SelectionKeyEvent = {
  ctrl?: boolean
  name: string
  preventDefault: () => void
  stopPropagation: () => void
}

export function copy(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  clipboard
    ?.write?.(clipboardText)
    .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
    .catch(toast.error)

  renderer.clearSelection()
  return true
}

export function handleSelectionKey(
  renderer: Renderer,
  toast: Toast,
  event: SelectionKeyEvent,
  clipboard: ClipboardService,
) {
  const selection = renderer.getSelection()
  if (!selection) return

  if (event.ctrl && event.name === "c") {
    if (!copy(renderer, toast, clipboard)) {
      renderer.clearSelection()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (event.name === "escape") {
    renderer.clearSelection()
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const focus = renderer.currentFocusedRenderable
  if (focus?.hasSelection() && selection.selectedRenderables.includes(focus)) return

  renderer.clearSelection()
}

export * as Selection from "./selection"
