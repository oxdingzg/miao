import type { ReferenceInfo, SkillV2Info } from "@miao/schema/view-models"
import type { LocationRef } from "@miao/schema/view-models"
import type {
  AgentsListOutput,
  CommandsListOutput,
  IntegrationsListOutput,
  ModelsListOutput,
  ProvidersListOutput,
} from "@miao/client"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { createSignal, onCleanup, onMount } from "solid-js"

type LocationData = {
  agent?: AgentsListOutput["data"]
  command?: CommandsListOutput["data"]
  integration?: IntegrationsListOutput["data"]
  model?: ModelsListOutput["data"]
  provider?: ProvidersListOutput["data"]
  reference?: ReferenceInfo[]
  skill?: SkillV2Info[]
}

type Data = {
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

// The TUI renders sessions from `sync.tsx`; this context only supplies the
// per-location lists the prompt autocomplete reads (references today). It
// deliberately does not subscribe to session transcript events.
export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({ location: {} })

    const sdk = useSDK()
    const events = useEvent()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })

    // The refreshes now run concurrently, so the bucket a refresh writes into is
    // not guaranteed to exist yet: only `location.refresh` used to create it, and
    // whichever response landed first won. A nested setStore on a missing bucket
    // throws inside solid's updatePath, and that rejection is fatal to the TUI.
    const ensureLocation = (key: string) => {
      if (!store.location[key]) setStore("location", key, {})
    }

    const result = {
      location: {
        default() {
          return defaultLocation()
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.api.location.get({ location: locationQuery(ref) }, {})
          const location = response
          const key = locationKey(location)
          ensureLocation(key)
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.agents.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "agent", result.data)
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.commands.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "command", result.data)
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.integrations.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "integration", result.data)
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.models.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "model", result.data)
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.providers.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "provider", result.data)
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.references.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "reference", result.data)
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.api.skills.list({ location: locationQuery(ref) }, {})
            const key = locationKey(result.location)
            ensureLocation(key)
            setStore("location", key, "skill", result.data)
          },
        },
      },
    }

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        const location = { directory: metadata.directory, workspaceID: metadata.workspace }
        switch (event.type) {
          case "catalog.updated":
            void Promise.all([result.location.model.refresh(location), result.location.provider.refresh(location)])
            break
          case "reference.updated":
            void result.location.reference.refresh()
            break
          case "integration.updated":
            void Promise.all([
              result.location.integration.refresh(location),
              result.location.model.refresh(location),
              result.location.provider.refresh(location),
            ])
            break
        }
      })
      onCleanup(unsub)

      void Promise.allSettled([
        result.location.refresh(),
        result.location.agent.refresh(),
        result.location.integration.refresh(),
        result.location.model.refresh(),
        result.location.provider.refresh(),
        result.location.reference.refresh(),
        result.location.command.refresh(),
        result.location.skill.refresh(),
      ]).then((settled) => {
        for (const failure of settled.filter((item) => item.status === "rejected"))
          console.error("Failed to refresh default location data", failure.reason)
      })
    })

    return result
  },
})
