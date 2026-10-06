export * as WindowLifecycle from "./lifecycle"

const resources = new Set<() => Promise<unknown>>()
const state: { closing?: Promise<void>; core?: Promise<void>; installed: boolean } = { installed: false }

/** All resources registered here belong to this invocation, never to another window. */
export function register(stop: () => Promise<unknown>) {
  if (state.closing) throw new Error("This miao window is closing")
  resources.add(stop)
  return () => resources.delete(stop)
}

export function close() {
  if (state.closing) return state.closing
  state.closing = (async () => {
    const errors: unknown[] = []
    await [...resources].reverse().reduce(
      (tail, stop) =>
        tail.then(stop).then(
          () => undefined,
          (error: unknown) => {
            errors.push(error)
          },
        ),
      Promise.resolve(),
    )
    resources.clear()
    if (errors.length) throw new AggregateError(errors, "Window shutdown did not finish cleanly")
  })()
  return state.closing
}

export function install() {
  if (state.installed) return
  state.installed = true
  const exit = (code: number) => {
    const timeout = setTimeout(() => process.exit(code), 10_000)
    void close()
      .catch(console.error)
      .finally(() => {
        clearTimeout(timeout)
        process.exit(code)
      })
  }
  process.once("SIGINT", () => exit(130))
  process.once("SIGTERM", () => exit(143))
  process.once("SIGHUP", () => exit(129))
}

/** Dispose the process graph once, after owned listeners and executions stop. */
export function disposeCore() {
  state.core ??= (async () => {
    const { AppRuntime } = await import("../effect/app-runtime")
    await AppRuntime.dispose()
  })()
  return state.core
}
