#!/usr/bin/env bun

// Release bodies are English and always link to the Simplified Chinese mirror
// at `docs/releases/<tag>.zh.md`. This reads the generated notes on stdin, adds
// the `[简体中文]` link under the first heading, and writes the result to
// stdout. It exits non-zero when the mirror is missing, so a release cannot
// ship without its Chinese notes.
//
// The mirror is linked on `main` (not the tag) because miao's notes are
// generated after the tag is cut, so older tags do not contain the file.
//
// Usage: bun script/release-notes.ts <tag> < notes.md > body.md

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
  const notes = await Bun.stdin.text()
  process.stdout.write(addChineseLink(notes, tag, repo))
}
