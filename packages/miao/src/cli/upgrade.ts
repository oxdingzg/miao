import path from "path"
import semver from "semver"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@miao/core/flag/flag"
import { Installation } from "@/installation"
import { writeUpgradeResult } from "@/installation/upgrade-result"
import { InstallationVersion } from "@miao/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Global } from "@miao/core/global"
import { Flock } from "@miao/core/util/flock"
import { errorMessage } from "@/util/error"

// How long a cached "latest version" is trusted before refreshing in the
// background. Startup never waits on the network (see upgrade()).
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000

// A crashed installer is reclaimable after this long; a live one keeps the lock
// fresh with a heartbeat, so this only bounds crash recovery.
const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_KEY = "installation-upgrade"

interface Cache {
  checkedAt: number
  latest?: string
  installed?: string
}

const cacheFile = () => path.join(Global.Path.state, "upgrade.json")

async function readCache(): Promise<Cache | undefined> {
  return Bun.file(cacheFile())
    .json()
    .catch(() => undefined)
}

async function writeCache(cache: Cache) {
  await Bun.write(cacheFile(), JSON.stringify(cache)).catch(() => {})
}

function emitAvailable(version: string) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: Installation.Event.UpdateAvailable.type, properties: { version } },
  })
}

function emitUpdated(version: string) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: Installation.Event.Updated.type, properties: { version } },
  })
}

async function refreshCache(installed: string) {
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => undefined)
  if (latest) await writeCache({ checkedAt: Date.now(), latest, installed })
}

/** Install methods we upgrade in the background. Package managers are opt-in. */
function autoInstalls(method: Installation.Method) {
  if (method === "curl" || method === "npm" || method === "pnpm" || method === "bun") return true
  return Flag.MIAO_PACKAGE_MANAGER_AUTO_UPDATE && (method === "brew" || method === "choco" || method === "scoop")
}

/**
 * Single non-blocking attempt at the shared upgrade lock. `timeoutMs: 0` makes
 * a held lock fail immediately: another process is already installing, so this
 * one skips instead of waiting and installing a second time.
 */
async function acquireUpgradeLock() {
  try {
    return await Flock.acquire(LOCK_KEY, { staleMs: LOCK_STALE_MS, timeoutMs: 0 })
  } catch {
    return undefined
  }
}

/**
 * Check for updates and, by default, upgrade in the background. The running
 * process keeps the old build; the TUI shows a non-blocking "restart to apply"
 * notice. Unlike the previous behavior there is no blocking confirmation dialog.
 */
export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.MIAO_DISABLE_AUTOUPDATE) return
  // Preview/dev builds use `0.0.1-<channel>-<timestamp>` versions that cannot be
  // compared against release versions; never notify or self-upgrade them.
  if (Installation.isPreview()) return

  const cache = await readCache()
  if (!cache || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
    // Refresh in the background; this run uses the previously cached value.
    void refreshCache(InstallationVersion).catch(() => {})
  }

  const latest = cache?.latest
  if (!latest || latest === InstallationVersion || !semver.gt(latest, InstallationVersion)) return

  const method = await Installation.method()

  if (Flag.MIAO_ALWAYS_NOTIFY_UPDATE || config.autoupdate === "notify" || method === "unknown") {
    emitAvailable(latest)
    return
  }

  if (!autoInstalls(method)) {
    // e.g. brew/winget without opt-in: tell the user, don't run a command.
    emitAvailable(latest)
    return
  }

  const lock = await acquireUpgradeLock()
  if (!lock) return

  try {
    await Installation.upgrade(method, latest)
    await writeCache({ checkedAt: Date.now(), latest, installed: latest })
    await writeUpgradeResult({ outcome: "success", method, versionFrom: InstallationVersion, versionTo: latest })
    emitUpdated(latest)
  } catch (error) {
    await writeUpgradeResult({
      outcome: "failure",
      method,
      versionFrom: InstallationVersion,
      versionTo: latest,
      error: errorMessage(error),
    })
    emitAvailable(latest)
  } finally {
    await lock.release().catch(() => {})
  }
}
