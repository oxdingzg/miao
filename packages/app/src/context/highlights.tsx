import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@miao/ui/context"
import { useDialog } from "@miao/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"
import { DialogReleaseNotes, type Highlight } from "@/components/dialog-release-notes"

const CHANGELOG_URL = "https://api.github.com/repos/oxdingzg/miao/releases?per_page=100"

type Store = {
  version?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^[vV]/, "")
}

export function loadReleaseHighlights(value: unknown, current?: string, previous?: string): Highlight[] {
  if (!Array.isArray(value) || !current) return []
  const releases = value.filter(
    (release): release is Record<string, unknown> =>
      isRecord(release) && release.draft === false && release.prerelease === false && typeof release.tag_name === "string",
  )
  const start = releases.findIndex((release) => normalizeVersion(String(release.tag_name)) === normalizeVersion(current))
  // Local builds and unpublished versions must not display another release's notes.
  if (start === -1) return []
  const previousIndex = previous
    ? releases.findIndex((release) => normalizeVersion(String(release.tag_name)) === normalizeVersion(previous))
    : -1
  if (previousIndex !== -1 && previousIndex <= start) return []
  const end = previousIndex === -1 ? start + 1 : previousIndex
  return releases.slice(start, end).flatMap((release) => {
    if (typeof release.body !== "string" || !release.body.trim()) return []
    return [{
      title: typeof release.name === "string" && release.name.trim() ? release.name : String(release.tag_name),
      description: release.body.trim(),
    }]
  }).slice(0, 5)
}

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const dialog = useDialog()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const [range, setRange] = createStore({
      from: undefined as string | undefined,
      to: undefined as string | undefined,
    })
    const state = { started: false }
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    const start = (previous: string) => {
      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        clearTimer()
      })

      fetcher(CHANGELOG_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
        .then((json) => {
          if (!json) return
          const highlights = loadReleaseHighlights(json, platform.version, previous)
          if (controller.signal.aborted) return

          if (highlights.length === 0) {
            markSeen()
            return
          }

          timer = setTimeout(() => {
            timer = undefined
            markSeen()
            dialog.show(() => <DialogReleaseNotes highlights={highlights} />)
          }, 500)
        })
        .catch(() => undefined)
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setRange({ from: previous, to: platform.version })
      start(previous)
    })

    return {
      ready,
      from: () => range.from,
      to: () => range.to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
