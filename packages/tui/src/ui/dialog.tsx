import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
import { useTheme } from "../context/theme"
import { MouseButton, Renderable, RGBA, type BoxRenderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { Flag } from "@miao/core/flag/flag"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { useClipboard } from "../context/clipboard"

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    placement?: "center" | "bottom"
    anchor?: () => BoxRenderable | undefined
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()
  // A bottom sheet sits directly above the prompt and matches its width, the way
  // Claude Code and Codex show pickers in place of the composer. Layout moves the
  // prompt without notifying anyone, so poll its box while the sheet is open.
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 50)
  onCleanup(() => clearInterval(timer))
  const anchored = createMemo(
    () => {
      tick()
      dimensions()
      if (props.placement !== "bottom") return undefined
      const box = props.anchor?.()
      if (!box || box.isDestroyed || !box.visible || box.width < 20 || box.y < 12) return undefined
      return { left: box.x, width: box.width, bottom: dimensions().height - box.y }
    },
    undefined,
    {
      equals: (a, b) => a?.left === b?.left && a?.width === b?.width && a?.bottom === b?.bottom,
    },
  )

  let dismiss = false
  const width = () => {
    if (props.size === "xlarge") return 116
    if (props.size === "large") return 88
    return 60
  }

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection()
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false
          return
        }
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems={props.placement === "bottom" ? "flex-start" : "center"}
      justifyContent={props.placement === "bottom" ? "flex-end" : "flex-start"}
      flexDirection="column"
      position="absolute"
      zIndex={3000}
      paddingTop={props.placement === "bottom" ? 0 : Math.floor(dimensions().height / 4)}
      paddingBottom={props.placement === "bottom" && !anchored() ? Math.min(7, Math.floor(dimensions().height / 4)) : 0}
      paddingLeft={props.placement === "bottom" && !anchored() ? 1 : 0}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 0)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          // A selection release must bubble up to the copy-on-select handler in
          // DialogProvider; the backdrop's dismiss flag keeps it from closing the dialog.
          if (renderer.getSelection()?.getSelectedText()) return
          dismiss = false
          e.stopPropagation()
        }}
        width={anchored()?.width ?? width()}
        maxWidth={dimensions().width - 2}
        position={anchored() ? "absolute" : undefined}
        left={anchored()?.left}
        bottom={anchored()?.bottom}
        backgroundColor={theme.backgroundPanel}
        border={props.placement === "bottom" ? true : undefined}
        borderColor={theme.border}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [anchor, setAnchor] = createSignal<() => BoxRenderable | undefined>()
  const [store, setStore] = createStore({
    stack: [] as {
      element: JSX.Element
      onClose?: () => void
    }[],
    placement: "center" as "center" | "bottom",
    size: "medium" as "medium" | "large" | "xlarge",
  })

  const renderer = useRenderer()
  const modeStack = useOpencodeModeStack()

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = modeStack.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  useBindings(() => ({
    enabled: store.stack.length > 0 && !renderer.getSelection()?.getSelectedText(),
    bindings: [
      {
        key: "escape",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
      {
        key: "ctrl+c",
        desc: "Close dialog",
        group: "Dialog",
        cmd: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
    ],
  }))

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("placement", "center")
        setStore("size", "medium")
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: any, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("placement", "center")
      setStore("size", "medium")
      setStore("stack", [
        {
          element: input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    get placement() {
      return store.placement
    },
    get anchor() {
      return anchor()
    },
    /** Register the prompt box that bottom sheets align to; returns the unregister. */
    setAnchor(box: () => BoxRenderable | undefined) {
      setAnchor(() => box)
      return () => setAnchor((current) => (current === box ? undefined : current))
    },
    setPlacement(placement: "center" | "bottom") {
      setStore("placement", placement)
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()

  function copySelection() {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text || !clipboard.write) return false
    void clipboard.write(text).then(
      () => toast.show({ message: "Copied to clipboard", variant: "info" }),
      (error) => toast.error(error),
    )
    renderer.clearSelection()
    return true
  }

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: number; preventDefault(): void; stopPropagation(): void }) => {
          if (!Flag.MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copySelection()) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={!Flag.MIAO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? copySelection : undefined}
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size} placement={value.placement} anchor={value.anchor}>
            {value.stack.at(-1)!.element}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
