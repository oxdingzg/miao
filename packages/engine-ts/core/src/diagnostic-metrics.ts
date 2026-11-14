export * as DiagnosticMetrics from "./diagnostic-metrics"

const readers = new Map<symbol, { name: string; read: () => unknown }>()

/** Producers own their lifetime; snapshots are sampled by the existing monitor. */
export function register(name: string, read: () => unknown) {
  const key = Symbol(name)
  readers.set(key, { name, read })
  return () => {
    readers.delete(key)
  }
}

export function snapshot() {
  return [...readers.values()].map((entry) => {
    try {
      return { name: entry.name, value: entry.read() }
    } catch {
      return { name: entry.name, value: null }
    }
  })
}
