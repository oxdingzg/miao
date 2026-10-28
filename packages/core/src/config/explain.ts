export * as ConfigExplain from "./explain"

import type { Entry } from "@miao/schema/config"

/**
 * Where a configuration document comes from, in the order the product reads
 * them: the user's global directory, the project's own config files, the
 * `.miao`/`.opencode` directories inside that project, then the environment
 * overrides `MIAO_CONFIG`, `MIAO_CONFIG_DIR` and `MIAO_CONFIG_CONTENT`.
 *
 * The labels stay separate from the load order on purpose: "where did this
 * value come from" and "which file won" are different questions once an
 * environment override points at a file.
 */
export type Scope = "global" | "project" | "local" | "env"

export interface Origin {
  readonly scope: Scope
  /** The file or directory behind the entry; absent for inline content. */
  readonly path?: string
}

export interface Source {
  readonly origin: Origin
  /** Dotted leaf paths this document defines, in document order. */
  readonly keys: readonly (readonly string[])[]
}

export interface Leaf {
  readonly value: unknown
  readonly origin: Origin
}

export interface Key {
  /** Dotted path segments, so a provider named `a.b` stays distinct. */
  readonly path: readonly string[]
  readonly value: unknown
  readonly origin: Origin
  /** Values this key replaced, lowest priority first. */
  readonly overridden: readonly Leaf[]
}

export interface Explanation {
  /** Documents in load order, lowest priority first. */
  readonly sources: readonly Source[]
  /** Effective leaves in first-seen order. */
  readonly keys: readonly Key[]
}

/** One loaded entry together with the scope the loader read it from. */
export interface ScopedEntry {
  readonly entry: Entry
  readonly scope: Scope
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Flattens a document into leaf paths. Objects recurse because the merge is
 * deep, so two files can each own part of one object; arrays and scalars are
 * leaves because a higher-priority file replaces them whole. An empty object
 * contributes nothing: merging it changes no value.
 */
const leaves = (value: Record<string, unknown>, prefix: readonly string[] = []): [string[], unknown][] =>
  Object.entries(value).flatMap(([key, item]) => {
    const path = [...prefix, key]
    return isRecord(item) ? leaves(item, path) : [[path, item] as [string[], unknown]]
  })

const origin = (entry: Entry, scope: Scope): Origin => (entry.path ? { scope, path: entry.path } : { scope })

/**
 * Reports the effective value of every configuration leaf, which document it
 * came from, and the values it overrode. Documents are merged exactly the way
 * `Config.merge` merges them, so the winning value here is the value the rest
 * of the product reads.
 */
export function explain(scoped: readonly ScopedEntry[]): Explanation {
  const keys = new Map<string, Key>()
  for (const item of scoped) {
    if (item.entry.type !== "document") continue
    const from = origin(item.entry, item.scope)
    for (const [path, value] of leaves(item.entry.info as unknown as Record<string, unknown>)) {
      const id = JSON.stringify(path)
      const current = keys.get(id)
      keys.set(id, {
        path,
        value,
        origin: from,
        overridden: current ? [...current.overridden, { value: current.value, origin: current.origin }] : [],
      })
    }
  }
  return {
    sources: scoped.map((item) => ({
      origin: origin(item.entry, item.scope),
      keys:
        item.entry.type === "document"
          ? leaves(item.entry.info as unknown as Record<string, unknown>).map(([path]) => path)
          : [],
    })),
    keys: [...keys.values()],
  }
}
