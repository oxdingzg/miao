import path from "path"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@miao/schema/view-models"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

/**
 * Zsh-style history-search-backward: walk one matching entry older than
 * `index`. The current input is the query; a mismatch between the entry the
 * cursor parked on and the typed input means the user edited it, so the
 * search restarts from the newest match for the new query.
 */
export function previousHistoryMatch(
  history: readonly PromptInfo[],
  index: number,
  query: string,
  typed: string,
): { index: number; entry: PromptInfo } | undefined {
  if (!history.length || !query) return undefined
  const current = history.at(index)
  // The cursor parked on a different text than what is typed now: the user
  // edited the input, so the search restarts from the newest entry.
  const start = index !== 0 && current && current.input !== typed ? 0 : index
  let next = start === 0 ? -1 : start - 1
  while (next < 0 && Math.abs(next) <= history.length) {
    const candidate = history.at(next)
    if (candidate?.input.includes(query)) {
      return { index: next, entry: candidate }
    }
    next -= 1
  }
  return undefined
}

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0)
        writeText(historyPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    })

    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      // Zsh-style history-search-backward: the current input is the query, and
      // each press walks one more matching entry older. Editing the input resets
      // the search to the newest match for the new query.
      searchBackward(query: string, input: string) {
        const match = previousHistoryMatch(store.history, store.index, query, input)
        if (match) setStore("index", match.index)
        return match?.entry
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
          }),
        )

        if (trimmed) {
          writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
          return
        }
        appendText(historyPath, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
