import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import { parseColor, type BoxRenderable, type RGBA } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// Every TUI animation advances on this one clock. Under Bun, a timer wakeup that
// allocates ends in a JSC eden collection, and in the TUI each one costs several
// milliseconds (WeakMap and code-finalizer scans over the whole heap), far more
// than the frame itself. Independent spinner timers therefore cost CPU per wakeup;
// sharing one clock keeps any number of visible spinners at one wakeup per frame.
export const ANIMATION_INTERVAL = 160

const [tick, setTick] = createSignal(0)
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

/** Frames elapsed on the shared animation clock since the caller mounted. */
export function useAnimationFrame(): Accessor<number> {
  subscribers++
  if (!timer) timer = setInterval(() => setTick((value) => value + 1), ANIMATION_INTERVAL)
  onCleanup(() => {
    subscribers--
    if (subscribers > 0 || !timer) return
    clearInterval(timer)
    timer = undefined
  })
  const start = tick()
  return () => tick() - start
}

const SECOND_INTERVAL = 1000
const [second, setSecond] = createSignal(0)
let secondSubscribers = 0
let secondTimer: ReturnType<typeof setInterval> | undefined

/**
 * Seconds elapsed on a shared one-second clock. Elapsed-time labels (a running
 * tool, a waiting prompt) used to each own an interval; one shared clock keeps
 * any number of them at a single wakeup per second, for the same reason the
 * animation clock is shared.
 */
export function useSecond(): Accessor<number> {
  secondSubscribers++
  if (!secondTimer) secondTimer = setInterval(() => setSecond((value) => value + 1), SECOND_INTERVAL)
  onCleanup(() => {
    secondSubscribers--
    if (secondSubscribers > 0 || !secondTimer) return
    clearInterval(secondTimer)
    secondTimer = undefined
  })
  const start = second()
  return () => second() - start
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <SpinnerFrame color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

function SpinnerFrame(props: { color: RGBA }) {
  const frame = useAnimationFrame()
  let view: BoxRenderable | undefined
  createEffect(() => {
    frame()
    props.color
    view?.requestRender()
  })
  // Fixed-size drawing keeps animation ticks out of the text/Yoga layout path.
  return (
    <box
      width={1}
      height={1}
      flexShrink={0}
      ref={(value) => (view = value)}
      renderAfter={function (buffer) {
        buffer.drawText(SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]!, this.x, this.y, props.color)
      }}
    />
  )
}

/** Multi-cell scanner whose cells are coloured per frame, e.g. the knight-rider prompt indicator. */
export function ScannerSpinner(props: { frames: string[]; color: ColorGenerator }) {
  const frame = useAnimationFrame()
  let view: BoxRenderable | undefined
  createEffect(() => {
    frame()
    props.frames
    props.color
    view?.requestRender()
  })
  return (
    <box
      width={Array.from(props.frames[0] ?? "").length}
      height={1}
      flexShrink={0}
      ref={(value) => (view = value)}
      renderAfter={function (buffer) {
        const index = frame() % props.frames.length
        const cells = Array.from(props.frames[index] ?? "")
        cells.forEach((cell, offset) =>
          buffer.drawText(cell, this.x + offset, this.y, parseColor(props.color(index, offset, props.frames.length, cells.length))),
        )
      }}
    />
  )
}
