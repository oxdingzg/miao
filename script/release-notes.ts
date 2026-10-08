#!/usr/bin/env bun

// Release bodies use the curated English document, paired with a Simplified
// Chinese document. Generated commit summaries on stdin are deliberately not
// the release body: they omit the verification and upgrade details in the pair.
// Both documents must exist before publication.
//
// Usage: bun script/release-notes.ts <tag> < generated.md > body.md

export const repoDefault = "oxdingzg/miao"

export function chineseLink(tag: string, repo: string = repoDefault): string {
  return `[简体中文](https://github.com/${repo}/blob/main/docs/releases/${tag}.zh.md)`
}

export function addChineseLink(notes: string, tag: string, repo: string = repoDefault): string {
  const link = chineseLink(tag, repo)
  const lines = notes.split("\n")
  const heading = lines.findIndex((line) => line.startsWith("#"))
  if (heading === -1) return `${link}\n\n${notes}`
  lines.splice(heading + 1, 0, "", link)
  return lines.join("\n")
}

if (import.meta.main) {
  const tag = process.argv[2]
  if (!tag) {
    console.error("usage: bun script/release-notes.ts <tag>")
    process.exit(2)
  }
  const repo = process.env.GH_REPO ?? repoDefault
  const mirror = `docs/releases/${tag}.zh.md`
  if (!(await Bun.file(mirror).exists())) {
    console.error(`missing Chinese release notes: ${mirror}`)
    process.exit(1)
  }
  const english = `docs/releases/${tag}.md`
  if (!(await Bun.file(english).exists())) {
    console.error(`missing English release notes: ${english}`)
    process.exit(1)
  }
  // Drain the producer so a pipefail-enabled publishing pipeline cannot see a
  // broken pipe merely because the curated notes take precedence.
  await Bun.stdin.text()
  process.stdout.write(addChineseLink(await Bun.file(english).text(), tag, repo))
}
