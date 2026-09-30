import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"

export function SessionMessageContent(props: { sessionID: string; body: string; title?: string; conceal: boolean }) {
  const theme = useTheme()
  const source = createMemo(() =>
    props.sessionID.length > 22 ? `${props.sessionID.slice(0, 12)}…${props.sessionID.slice(-6)}` : props.sessionID,
  )

  return (
    <box gap={1} minWidth={0}>
      <box>
        <text fg={theme.theme.secondary}>
          <b>↳ Session message</b>
        </text>
        <text fg={theme.theme.textMuted}>
          From: {props.title ? `${props.title} · ` : ""}
          {source()}
        </text>
      </box>
      <Show when={props.body.trim()} fallback={<text fg={theme.theme.textMuted}>(empty message)</text>}>
        <markdown
          syntaxStyle={theme.syntax()}
          streaming={false}
          internalBlockMode="top-level"
          content={props.body}
          tableOptions={{ style: "grid" }}
          conceal={props.conceal}
          fg={theme.theme.markdownText}
          bg={theme.theme.backgroundPanel}
        />
      </Show>
    </box>
  )
}
