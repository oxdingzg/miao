import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  MIAO_CHANNEL: process.env["MIAO_CHANNEL"],
  MIAO_BUMP: process.env["MIAO_BUMP"],
  MIAO_VERSION: process.env["MIAO_VERSION"],
  MIAO_RELEASE: process.env["MIAO_RELEASE"],
}
const REPO = "oxdingzg/miao"

const CHANNEL = await (async () => {
  if (env.MIAO_CHANNEL) return env.MIAO_CHANNEL
  if (env.MIAO_BUMP) return "latest"
  if (env.MIAO_VERSION && !env.MIAO_VERSION.includes("-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.MIAO_VERSION) return env.MIAO_VERSION
  if (IS_PREVIEW) return `0.0.1-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // miao versions independently from upstream opencode. Base the next release on
  // the latest tag published in this repository, starting at 0.0.1.
  const release: unknown = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((res) => (res.ok ? res.json() : undefined))
    .catch(() => undefined)
  const tag =
    release && typeof release === "object" && "tag_name" in release && typeof release.tag_name === "string"
      ? release.tag_name
      : undefined
  const [major, minor, patch] = (tag?.replace(/^v/, "") ?? "0.0.0").split(".").map((x: string) => Number(x) || 0)
  const t = env.MIAO_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.MIAO_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`miao script`, JSON.stringify(Script, null, 2))
