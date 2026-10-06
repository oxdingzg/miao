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
const CHANNEL = env.MIAO_CHANNEL ?? (env.MIAO_RELEASE ? "latest" : (await $`git branch --show-current`.text()).trim())
const IS_PREVIEW = CHANNEL !== "latest"
const VERSION = rootPkg.version

if (typeof VERSION !== "string" || !semver.valid(VERSION)) {
  throw new Error("Root package.json must contain a semantic version")
}
if (env.MIAO_VERSION && env.MIAO_VERSION !== VERSION) {
  throw new Error(
    `MIAO_VERSION ${env.MIAO_VERSION} differs from package.json ${VERSION}; run bun script/set-version.ts first`,
  )
}
if (env.MIAO_BUMP) {
  throw new Error("MIAO_BUMP is no longer supported; set the version with bun script/set-version.ts X.Y.Z")
}

for (const pattern of rootPkg.workspaces.packages) {
  for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: path.dirname(rootPkgPath) })) {
    const pkg = await Bun.file(path.join(path.dirname(rootPkgPath), file)).json()
    if (pkg.version !== undefined && pkg.version !== VERSION) {
      throw new Error(
        `${file} version ${pkg.version} differs from package.json ${VERSION}; run bun script/set-version.ts`,
      )
    }
  }
}

// Keep the opencode entries: miao's history still contains upstream commits by
// those accounts, and dropping them would leak bot commits into the changelog.
const bot = ["actions-user", "opencode", "opencode-agent[bot]", "miao-agent[bot]"]
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
