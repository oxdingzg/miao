/** @jsxImportSource @opentui/solid */
import { TextBuffer, TextBufferView } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { ErrorBoundary } from "../../src/component/error-boundary"

const [allocate, setAllocate] = createSignal(false)
const buffers: TextBuffer[] = []
const views: TextBufferView[] = []
let handled = 0
let fallback = 0
let failure = ""
const app = await testRender(
  () => (
    <ErrorBoundary
      onNativeResourceError={(report) => {
        handled++
        failure = report.error.message
        queueMicrotask(() => app.renderer.destroy())
      }}
      fallback={() => {
        fallback++
        return <text>must not allocate a crash screen</text>
      }}
    >
      <Show when={allocate()}>
        <text>forces another native allocation</text>
      </Show>
    </ErrorBoundary>
  ),
  { width: 60, height: 4 },
)
await app.renderOnce()
try {
  // Fill the real process-wide native table, not a mocked constructor. Run in
  // an isolated process because a failed constructor can leave a partial node.
  for (let i = 0; i < 40000; i++) {
    const buffer = TextBuffer.create("wcwidth")
    buffers.push(buffer)
    views.push(TextBufferView.create(buffer))
  }
} catch {}
setAllocate(true)
await new Promise((resolve) => setTimeout(resolve, 0))
const destroyed = app.renderer.isDestroyed
for (const view of views) view.destroy()
for (const buffer of buffers) buffer.destroy()
console.log(JSON.stringify({ handled, fallback, destroyed, failure }))
if (!destroyed) app.renderer.destroy()
