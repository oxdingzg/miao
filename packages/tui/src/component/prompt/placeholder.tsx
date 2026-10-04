import type { RGBA } from "@opentui/core"
import { Show, type ParentProps } from "solid-js"

export function PromptPlaceholder(
  props: ParentProps<{
    value: string
    text?: string
    color: RGBA
    onMouseDown: () => void
  }>,
) {
  return (
    <box width="100%" flexShrink={0}>
      {props.children}
      {/* Keep the hint on one row, independent of the editor viewport and focus. */}
      <Show when={!props.value && props.text}>
        <text
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height={1}
          wrapMode="none"
          selectable={false}
          fg={props.color}
          onMouseDown={props.onMouseDown}
        >
          {props.text}
        </text>
      </Show>
    </box>
  )
}
