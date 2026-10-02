import { createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// Every TUI animation advances on this one clock. Under Bun, a timer wakeup that
// allocates ends in a JSC eden collection, and in the TUI each one costs several
// milliseconds (WeakMap and code-finalizer scans over the whole heap), far more
// than the frame itself. Independent spinner timers therefore cost CPU per wakeup;
// sharing one clock keeps any number of visible spinners at one wakeup per frame.
export const ANIMATION_INTERVAL = 80

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
  return (
    <text fg={props.color} flexShrink={0}>
      {SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]}
    </text>
  )
}

/** Multi-cell scanner whose cells are coloured per frame, e.g. the knight-rider prompt indicator. */
export function ScannerSpinner(props: { frames: string[]; color: ColorGenerator }) {
  const frame = useAnimationFrame()
  const index = () => frame() % props.frames.length
  const cells = () => Array.from(props.frames[index()] ?? "")
  return (
    <text flexShrink={0}>
      <For each={Array.from(props.frames[0] ?? "", (_, cell) => cell)}>
        {(cell) => (
          <span style={{ fg: props.color(index(), cell, props.frames.length, cells().length) }}>{cells()[cell]}</span>
        )}
      </For>
    </text>
  )
}
