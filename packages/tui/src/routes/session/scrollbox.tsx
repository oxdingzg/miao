import { createSignal, splitProps } from "solid-js"
import { type ColorInput, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core"
import { type JSX } from "@opentui/solid"

/** Keep the gutter stable while revealing the draggable thumb on hover. */
export function SessionScrollbox(
  props: JSX.IntrinsicElements["scrollbox"] & {
    alwaysShow: boolean
    thumbColor: ColorInput
    trackColor: ColorInput
    hiddenColor: ColorInput
  },
) {
  const [local, rest] = splitProps(props, ["alwaysShow", "thumbColor", "trackColor", "hiddenColor", "ref", "children"])
  const [hover, setHover] = createSignal(false)
  const [drag, setDrag] = createSignal(false)
  let scroll: ScrollBoxRenderable
  const inside = (event: MouseEvent) =>
    event.x >= scroll.x &&
    event.x < scroll.x + scroll.width &&
    event.y >= scroll.y &&
    event.y < scroll.y + scroll.height
  const update = (event: MouseEvent) => setHover(inside(event))
  const visible = () => local.alwaysShow || hover() || drag()
  return (
    <scrollbox
      {...rest}
      ref={(value) => {
        scroll = value
        if (typeof local.ref === "function") local.ref(value)
      }}
      viewportOptions={{ ...rest.viewportOptions, paddingRight: 1 }}
      verticalScrollbarOptions={{
        paddingLeft: 1,
        showArrows: false,
        trackOptions: {
          foregroundColor: visible() ? local.thumbColor : local.hiddenColor,
          backgroundColor: visible() ? local.trackColor : local.hiddenColor,
        },
      }}
      onMouseOver={update}
      onMouseOut={update}
      onMouseDown={(event) => {
        const bar = scroll.verticalScrollBar
        if (event.x >= bar.x && event.x < bar.x + bar.width && inside(event)) setDrag(true)
        update(event)
      }}
      onMouseUp={(event) => {
        setDrag(false)
        update(event)
      }}
      onMouseDragEnd={(event) => {
        setDrag(false)
        update(event)
      }}
    >
      {local.children}
    </scrollbox>
  )
}
