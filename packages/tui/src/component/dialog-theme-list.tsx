import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { For, onCleanup } from "solid-js"

export function DialogThemeList() {
  const theme = useTheme()
  const options = Object.keys(theme.all())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((value) => ({
      title: value,
      value: value,
    }))
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = theme.selected

  onCleanup(() => {
    if (!confirmed) theme.set(initial)
  })

  return (
    <DialogSelect
      title="Themes"
      options={options}
      current={initial}
      footer={<ThemePreview />}
      onMove={(opt) => {
        theme.set(opt.value)
      }}
      onSelect={(opt) => {
        theme.set(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          theme.set(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) theme.set(first.value)
      }}
    />
  )
}

// A theme is judged by how code and diffs look in it, and the list itself hides
// most of the screen, so the picker carries its own sample that follows the
// highlighted theme.
const SAMPLE = `function greet(name: string) {
  const count = 3 // retries
  return \`Hello, \${name}!\``

const DIFF = [
  { sign: "-", text: '  return "Hi " + name', kind: "removed" },
  { sign: "+", text: "  return `Hello, ${name}!`", kind: "added" },
] as const

function ThemePreview() {
  const { theme, syntax } = useTheme()
  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1}>
      <code conceal={false} fg={theme.text} filetype="typescript" syntaxStyle={syntax()} content={SAMPLE} />
      <For each={DIFF}>
        {(line) => (
          <box flexDirection="row" backgroundColor={line.kind === "added" ? theme.diffAddedBg : theme.diffRemovedBg}>
            <text fg={line.kind === "added" ? theme.diffHighlightAdded : theme.diffHighlightRemoved}>{line.sign} </text>
            <code conceal={false} fg={theme.text} filetype="typescript" syntaxStyle={syntax()} content={line.text} />
          </box>
        )}
      </For>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.primary }}>primary</span> · <span style={{ fg: theme.success }}>success</span> ·{" "}
        <span style={{ fg: theme.warning }}>warning</span> · <span style={{ fg: theme.error }}>error</span> · muted
      </text>
    </box>
  )
}
