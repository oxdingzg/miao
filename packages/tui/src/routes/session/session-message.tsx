import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"

const PREVIEW_LIMIT = 120

// A cross-session message that has not been promoted yet has no place in
// projected history, so it waits at the tail of the transcript as a local
// receipt. Rendering the whole body there let a few queued messages fill the
// viewport and push the user's own input and the running turn out of sight, so
// the pending form is a header plus one preview line. The full body arrives with
// the promoted message.
export function SessionMessageContent(props: {
  sessionID: string
  body: string
  title?: string
  conceal: boolean
  compact?: boolean
}) {
  const theme = useTheme()
  const source = createMemo(() =>
    props.sessionID.length > 22 ? `${props.sessionID.slice(0, 12)}…${props.sessionID.slice(-6)}` : props.sessionID,
  )
  const origin = createMemo(() => `From: ${props.title ? `${props.title} · ` : ""}${source()}`)
  const preview = createMemo(() => {
    const line =
      props.body
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim()
        .replace(/^(?:#{1,6}|>)\s+/, "") ?? ""
    return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT)}…` : line
  })

  return (
    <Show
      when={!props.compact}
      fallback={
        <box>
          <text fg={theme.theme.secondary}>
            <b>↳ Session message</b>
            <span style={{ fg: theme.theme.textMuted }}> {origin()}</span>
          </text>
          <Show when={preview()} fallback={<text fg={theme.theme.textMuted}>(empty message)</text>}>
            <text fg={theme.theme.textMuted}>{preview()}</text>
          </Show>
        </box>
      }
    >
      <box gap={1} minWidth={0}>
        <box>
          <text fg={theme.theme.secondary}>
            <b>↳ Session message</b>
          </text>
          <text fg={theme.theme.textMuted}>{origin()}</text>
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
    </Show>
  )
}
