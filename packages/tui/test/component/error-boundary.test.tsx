/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createMemo } from "solid-js"
import { ErrorBoundary } from "../../src/component/error-boundary"

// The shape that produced "undefined is not an object (evaluating
// 'actionItems().indexOf')" on the crash screen: a memo whose computation fails
// keeps its previous value, so the memo reading it fails one property access
// further out and the outermost failure is the one Solid's own boundary reports.
function Cascade() {
  const broken = createMemo<string[]>(() => {
    throw new Error("the real failure")
  })
  const outer = createMemo(() => broken().filter((value) => value))
  const read = createMemo(() => outer().indexOf("x"))
  return <text>{String(read())}</text>
}

test("reports the error that broke the subtree, not the cascade over it", async () => {
  const app = await testRender(
    () => (
      <ErrorBoundary fallback={(report) => <text>{`first=${report.error.message} count=${report.count}`}</text>}>
        <Cascade />
      </ErrorBoundary>
    ),
    { width: 60, height: 4 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("first=the real failure")
    expect(app.captureCharFrame()).not.toContain("indexOf")
    // The cascade is recorded after the first error stops propagating; the screen
    // must keep naming the error that started it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await app.renderOnce()
    const refreshed = app.captureCharFrame()
    expect(refreshed).toContain("first=the real failure")
    expect(Number(refreshed.match(/count=(\d+)/)?.[1])).toBeGreaterThan(1)
  } finally {
    app.renderer.destroy()
  }
})

test("reset drops the recorded error and renders the children again", async () => {
  let failing = true
  let resetBoundary = () => {}
  function Flaky() {
    const value = createMemo(() => {
      if (failing) throw new Error("the real failure")
      return "recovered"
    })
    return <text>{value()}</text>
  }

  const app = await testRender(
    () => (
      <ErrorBoundary
        fallback={(report, reset) => {
          resetBoundary = reset
          return <text>{`crashed=${report.error.message}`}</text>
        }}
      >
        <Flaky />
      </ErrorBoundary>
    ),
    { width: 40, height: 3 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("crashed=the real failure")
    failing = false
    resetBoundary()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("recovered")
  } finally {
    app.renderer.destroy()
  }
})
