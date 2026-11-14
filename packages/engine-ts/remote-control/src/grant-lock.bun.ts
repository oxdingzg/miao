import { Database } from "bun:sqlite"

export function openGrantLock(filename: string) {
  return new Database(filename, { create: true, readwrite: true })
}
