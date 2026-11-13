import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "opencode-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

/// Remove a test tree, tolerating the Windows file-lock windows (EBUSY,
/// EPERM, ENOTEMPTY) that outlive a closed SQLite handle for a few hundred
/// milliseconds. Exported for tests that build their own temp directories
/// instead of taking `tmpdir`.
export async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (
      retries === 0 ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
    )
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
