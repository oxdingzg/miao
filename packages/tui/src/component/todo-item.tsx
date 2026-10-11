import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  id?: string
  depends_on?: readonly string[]
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" gap={0}>
      <text
        flexShrink={0}
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        [
        {props.status === "completed"
          ? "✓"
          : props.status === "in_progress"
            ? "•"
            : props.status === "cancelled"
              ? "×"
              : props.status === "waiting"
                ? "…"
                : props.status === "blocked"
                  ? "!"
                  : " "}
        ]{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: props.status === "in_progress" ? theme.warning : theme.textMuted,
        }}
      >
        {props.id ? `${props.id}: ` : ""}
        {props.content}
        {props.depends_on?.length ? ` ← ${props.depends_on.join(", ")}` : ""}
      </text>
    </box>
  )
}
