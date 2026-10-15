#!/usr/bin/env bun
// A closed pull request leaves its branch behind: GitHub deletes a head branch
// when a pull request merges, but not when one is closed as superseded, and the
// branch then trails main until its content is unreadable. This reports every
// remote branch without an open pull request, with how far it is ahead of and
// behind main, so a stale one is visible before it rots. It never deletes: read
// the report, confirm the content landed, then
// `git push origin --delete <branch>`.
import { $ } from "bun"

const branches = (await $`git ls-remote --heads origin`.text())
  .split("\n")
  .map((line) => line.split("refs/heads/")[1])
  .filter((name): name is string => name !== undefined && name !== "main")
if (branches.length === 0) {
  console.log("no remote branches besides main")
  process.exit(0)
}
const open = new Set(
  (JSON.parse(await $`gh pr list --state open --json headRefName`.text()) as Array<{ headRefName: string }>).map(
    (pull) => pull.headRefName,
  ),
)
for (const branch of branches.sort()) {
  const ahead = Number((await $`git rev-list --count origin/main..origin/${branch}`.text()).trim())
  const behind = Number((await $`git rev-list --count origin/${branch}..origin/main`.text()).trim())
  const last = (await $`git log -1 --format=%cs origin/${branch}`.text()).trim()
  console.log(`${branch}: ${ahead} ahead, ${behind} behind, last commit ${last}, ${open.has(branch) ? "open pull request" : "no open pull request"}`)
}
