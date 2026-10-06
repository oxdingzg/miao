import { RuntimeRegistration } from "@miao/core/runtime/registration"
import { readdir } from "node:fs/promises"
import path from "node:path"

/** Tests inspect their isolated directory; production requires an explicit runtime ID. */
export async function readWindow(storage: string) {
  const prefix = `${path.basename(storage)}.runtime-`
  const files = await readdir(path.dirname(storage)).catch(() => [] as string[])
  const file = files.find((file) => file.startsWith(prefix) && file.endsWith(".json"))
  if (!file) return undefined
  return RuntimeRegistration.read(storage, file.slice(prefix.length, -5))
}
