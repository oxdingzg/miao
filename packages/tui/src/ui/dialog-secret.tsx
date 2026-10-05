import { useKeyboard, usePaste } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import type { DialogContext } from "./dialog"
import { useBindings } from "../keymap"

/** Never give the plaintext to a renderable, clipboard, or undo buffer. */
export function DialogSecret(props: { title: string; onConfirm(value: string): void; onCancel(): void }) {
  const { theme } = useTheme()
  const [length, setLength] = createSignal(0)
  let secret = ""
  const update = (value: string) => { secret = value.slice(0, 1024); setLength(Array.from(secret).length) }
  onCleanup(() => { secret = "" })
  const confirm = () => { const value = secret; update(""); props.onConfirm(value) }
  useBindings(() => ({ priority: 20, bindings: [
    { key: "return", desc: "Submit password", group: "Dialog", cmd: confirm },
    { key: "escape", desc: "Cancel password", group: "Dialog", cmd: () => { update(""); props.onCancel() } },
  ] }))
  useKeyboard((event) => {
    event.preventDefault(); event.stopPropagation()
    if (event.eventType === "release") return
    if (event.name === "escape") { update(""); props.onCancel(); return }
    if (event.name === "return") { confirm(); return }
    if (event.name === "backspace") { update(Array.from(secret).slice(0, -1).join("")); return }
    if (event.ctrl && event.name === "u") { update(""); return }
    if (!event.ctrl && !event.meta && !event.super && event.sequence && !/[\u0000-\u001f\u007f]/.test(event.sequence))
      update(secret + event.sequence)
  })
  usePaste((event) => {
    event.preventDefault(); event.stopPropagation()
    update(secret + new TextDecoder().decode(event.bytes).replace(/[\u0000-\u001f\u007f]/g, ""))
  })
  return <box padding={2} gap={1}>
    <text fg={theme.text}>{props.title}</text>
    <text fg={theme.text}>{"•".repeat(Math.min(length(), 48)) || "请输入密码"}</text>
    <text fg={theme.textMuted}>Enter 继续 · Esc 取消 · Ctrl+U 清空</text>
  </box>
}

DialogSecret.show = (dialog: DialogContext, title: string) => new Promise<string | null>((resolve) => {
  dialog.replace(() => <DialogSecret title={title} onConfirm={resolve} onCancel={() => resolve(null)} />, () => resolve(null))
})
