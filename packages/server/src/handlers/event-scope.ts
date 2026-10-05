import type { Location } from "@miao/core/location"

export type SubscriberScope = {
  readonly directory: string
  readonly workspaceID?: string
}

/**
 * The subscriber's location, from the request query (the SDK's `location[...]`
 * params) or the `x-opencode-*` headers. Undefined when the client did not
 * name one, in which case no filtering happens.
 */
export function subscriberScope(input: {
  readonly url: string
  readonly headers: Record<string, string | undefined>
}): SubscriberScope | undefined {
  const query = new URL(input.url, "http://localhost").searchParams
  const directory = query.get("location[directory]") ?? decode(input.headers["x-opencode-directory"])
  const workspaceID = query.get("location[workspace]") ?? input.headers["x-opencode-workspace"] ?? undefined
  return directory ? { directory, workspaceID } : undefined
}

/**
 * Whether an event belongs to the subscriber's location. Server-wide events
 * (no location) always belong. Workspace identity wins when either side has it;
 * otherwise directories are compared by ancestry so a client opened in a
 * subdirectory still receives its project's events. Unknown shapes fail open.
 */
export function inScope(location: Location.Ref | undefined, scope: SubscriberScope | undefined): boolean {
  if (!scope || !location) return true
  if (location.workspaceID || scope.workspaceID) return location.workspaceID === scope.workspaceID
  return related(location.directory, scope.directory)
}

/** Same path, or one is an ancestor of the other (at a path boundary). */
const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

const decode = (value: string | undefined) => {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
