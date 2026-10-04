import type { DeepMutable } from "@miao/core/schema"

// Promise-client responses are owned plain JSON. UI projections can mutate
// their arrays even though the generated public contract is readonly.
export function mutableResponse<T>(value: T) {
  return value as DeepMutable<T>
}
