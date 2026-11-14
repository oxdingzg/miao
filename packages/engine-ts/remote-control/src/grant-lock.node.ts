import { DatabaseSync } from "node:sqlite"

export function openGrantLock(filename: string) {
  return new DatabaseSync(filename)
}
