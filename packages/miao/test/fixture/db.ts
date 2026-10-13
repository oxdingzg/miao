import { rm } from "fs/promises"
import { Database } from "@miao/core/database/database"

export async function resetDatabase() {
  const dbPath = Database.path()
  await rm(dbPath, { force: true }).catch(() => undefined)
  await rm(`${dbPath}-wal`, { force: true }).catch(() => undefined)
  await rm(`${dbPath}-shm`, { force: true }).catch(() => undefined)
}
