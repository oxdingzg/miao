#!/usr/bin/env bun

// Deterministic changelog generation from Conventional Commits.
//
// Reads `git log <from>..<to>`, keeps user-facing commit types, maps them onto
// Keep a Changelog sections, and writes `UPCOMING_CHANGELOG.md` (used as GitHub
// release notes by `script/version.ts`). With `--write` it also prepends the
// section to `CHANGELOG.md`.

import { $ } from "bun"
import path from "path"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dir, "..")
const upcomingFile = path.join(root, "UPCOMING_CHANGELOG.md")
const changelogFile = path.join(root, "CHANGELOG.md")
const repo = process.env.GH_REPO ?? "oxdingzg/miao"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", short: "f" },
    to: { type: "string", short: "t", default: "HEAD" },
    version: { type: "string" },
    write: { type: "boolean", default: false },
    print: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/changelog.ts [options]

Options:
  -f, --from <ref>       Starting ref (default: latest non-draft GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
      --version <x.y.z>  Version heading for the generated section
      --write            Prepend the section to CHANGELOG.md
      --print            Print the generated section to stdout
  -h, --help             Show this help message
`)
  process.exit(0)
}

// Conventional type -> Keep a Changelog section, in output order.
const SECTIONS: ReadonlyArray<{ readonly title: string; readonly types: ReadonlyArray<string> }> = [
  { title: "Added", types: ["feat"] },
  { title: "Changed", types: ["refactor"] },
  { title: "Fixed", types: ["fix", "revert"] },
  { title: "Performance", types: ["perf"] },
  { title: "Removed", types: ["remove"] },
]

// Internal-only commit types that never reach the changelog.
const SKIP = new Set(["chore", "ci", "test", "docs", "style", "build", "release", "ignore"])

const parse = (subject: string) => {
  const match = subject.match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i)
  if (!match) return undefined
  return { type: match[1]!.toLowerCase(), scope: match[2], description: match[3]! }
}

const latestRelease = async () => {
  const data = (await $`gh api "/repos/${repo}/releases?per_page=100"`.json()) as Array<{
    tag_name: string
    draft: boolean
  }>
  return data.find((release) => !release.draft)?.tag_name
}

const resolve = (input: string) => (/^\d+\.\d+\.\d+/.test(input) ? `v${input}` : input)

const from = values.from ? resolve(values.from) : await latestRelease()
if (!from) throw new Error("No starting ref: pass --from <version> (no published release found).")

const log = await $`git log ${from}..${values.to} --no-merges --format=%h%x09%s`.cwd(root).text()

const groups = new Map(SECTIONS.map((section) => [section.title, [] as string[]]))
for (const line of log.split("\n")) {
  if (!line.trim()) continue
  const [hash, subject] = line.split("\t")
  if (!hash || !subject) continue
  const commit = parse(subject)
  if (!commit || SKIP.has(commit.type)) continue
  const section = SECTIONS.find((item) => item.types.includes(commit.type))?.title
  if (!section) continue
  const scope = commit.scope ? `**${commit.scope}**: ` : ""
  groups.get(section)!.push(`- ${scope}${commit.description} (\`${hash}\`)`)
}

const heading = values.version ? `## [${values.version}] - ${new Date().toISOString().slice(0, 10)}` : "## Unreleased"
const lines = [heading, ""]
const notable = SECTIONS.filter((section) => groups.get(section.title)!.length > 0)
if (notable.length === 0) {
  lines.push("No notable changes.")
} else {
  for (const section of notable) lines.push(`### ${section.title}`, ...groups.get(section.title)!, "")
}
const content = `${lines.join("\n").trimEnd()}\n`

await Bun.write(upcomingFile, content)
if (values.print) process.stdout.write(content)

if (values.write) {
  const existing = await Bun.file(changelogFile)
    .text()
    .catch(() => "")
  if (existing) {
    const lines = existing.split("\n")
    const unreleased = lines.findIndex((line) => line.trim() === "## [Unreleased]")
    let insertAt = lines.length
    for (let index = unreleased + 1; index < lines.length; index++) {
      if (lines[index]!.startsWith("## [")) {
        insertAt = index
        break
      }
    }
    const merged = [
      ...lines.slice(0, insertAt),
      ...content.trimEnd().split("\n"),
      "",
      ...lines.slice(insertAt),
    ].join("\n")
    await Bun.write(changelogFile, merged)
  } else {
    await Bun.write(changelogFile, content)
  }
}
