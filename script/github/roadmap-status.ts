#!/usr/bin/env bun
/**
 * Keeps the project board's Status column in step with the repository.
 *
 * The board tracks its work as draft issues: they carry no repository number,
 * so no pull request can close them and nothing moves a status on its own. Two
 * repository facts are enough to drive both directions.
 *
 * progress:   run after a pull request merges. Every roadmap code the pull
 *             request names in its title, or in its body through an explicit
 *             `miao-roadmap:CFG-02` marker, that the board tracks moves that
 *             item from Todo to In Progress, and the pull request is appended
 *             to the item's 关联证据 line.
 * acceptance: every committed record line `roadmap: CFG-02 done in v0.3.16`
 *             marks that item Done, provided the version has a published
 *             release. A merge never marks an item Done: an item is Done when a
 *             committed record says it passed acceptance.
 *
 * Usage:
 *   ROADMAP_TOKEN=... bun script/github/roadmap-status.ts progress --pr 1591
 *   ROADMAP_TOKEN=... bun script/github/roadmap-status.ts acceptance
 *
 * Both accept --dry-run to print the planned changes without writing any.
 */

const CODE = /\b[A-Z]{2,5}-\d{2}\b/g
const MARKER = /miao-roadmap:\s*([A-Z]{2,5}-\d{2})/g
const ACCEPTANCE = /^\s*roadmap:\s*([A-Z]{2,5}-\d{2})\s+done\s+in\s+v?(\d+\.\d+\.\d+)\s*$/

/**
 * The roadmap codes a pull request names that the board tracks: any code in the
 * title, and only an explicit `miao-roadmap:` marker in the body, where a bare
 * code is usually a mention of related work rather than this pull request's own.
 */
export function roadmapCodes(pull: { title: string; body?: string | null }, known: ReadonlySet<string>) {
  const codes = new Set(pull.title.match(CODE) ?? [])
  for (const match of (pull.body ?? "").matchAll(MARKER)) {
    const code = match[1]
    if (code) codes.add(code)
  }
  return [...codes].filter((code) => known.has(code))
}

/** The code a board item opens its title with, e.g. "[CFG-02] 配置…". */
export function itemCode(title: string) {
  return title.match(/^\[([A-Z]{2,5}-\d{2})\]/)?.[1]
}

/** Appends the pull request to the item's 关联证据 line, at most once. */
export function withEvidence(body: string, reference: { number: number; url: string }) {
  if (body.includes(reference.url)) return body
  const evidence = `[#${reference.number}](${reference.url})`
  const lines = body.split("\n")
  const index = lines.findIndex((line) => line.startsWith("关联证据："))
  const line = lines[index]
  if (!line) return [body.trimEnd(), `关联证据：${evidence}。`].filter(Boolean).join("\n\n")
  const current = line.trimEnd()
  const suffix = current.endsWith("。") ? "。" : current.endsWith(".") ? "." : ""
  const base = suffix ? current.slice(0, -1) : current
  return [...lines.slice(0, index), `${base} ${evidence}${suffix}`, ...lines.slice(index + 1)].join("\n")
}

/** Acceptance records a committed document carries. */
export function acceptanceRecords(markdown: string) {
  return markdown.split("\n").flatMap((line) => {
    const match = ACCEPTANCE.exec(line)
    const code = match?.[1]
    const version = match?.[2]
    return code && version ? [{ code, version }] : []
  })
}

type Connection = {
  token: string
  repo: string
  owner: string
  ownerType: string
  project: number
  dryRun: boolean
}

type Item = {
  id: string
  draftId?: string
  title: string
  body: string
  status?: string
}

type Board = {
  id: string
  fieldId: string
  option: Map<string, string>
  items: Item[]
}

const PROJECT_FIELDS = `
  id
  field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
`

const ITEM_PAGE = `
  query($project: ID!, $cursor: String) {
    node(id: $project) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content {
              __typename
              ... on DraftIssue { id title body }
              ... on Issue { id title body }
            }
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
        }
      }
    }
  }
`

type RawItem = {
  id: string
  content: { __typename: string; id: string; title: string; body: string } | null
  fieldValueByName: { name: string } | null
}

type ItemPage = {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: RawItem[]
    }
  }
}

const headers = (connection: Connection) => ({
  Authorization: `Bearer ${connection.token}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
})

async function graphql<T>(connection: Connection, query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: headers(connection),
    body: JSON.stringify({ query, variables }),
  })
  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] }
  if (!response.ok || payload.errors?.length) {
    const reason = payload.errors?.map((error) => error.message).join("; ") ?? response.statusText
    throw new Error(`GraphQL ${response.status}: ${reason}`)
  }
  if (!payload.data) throw new Error("GraphQL returned no data")
  return payload.data
}

async function board(connection: Connection): Promise<Board> {
  const data = await graphql<
    Record<string, { projectV2: { id: string; field: { id: string; options: { id: string; name: string }[] } | null } | null } | null>
  >(
    connection,
    `query($owner: String!, $number: Int!) {
      ${connection.ownerType}(login: $owner) { projectV2(number: $number) { ${PROJECT_FIELDS} } }
    }`,
    { owner: connection.owner, number: connection.project },
  )
  const project = data[connection.ownerType]?.projectV2
  if (!project?.field) {
    throw new Error(`${connection.ownerType} ${connection.owner} has no project #${connection.project} with a Status field`)
  }
  return {
    id: project.id,
    fieldId: project.field.id,
    option: new Map(project.field.options.map((option) => [option.name, option.id])),
    items: await items(connection, project.id),
  }
}

async function items(connection: Connection, project: string) {
  const collected: Item[] = []
  let cursor: string | null = null
  for (;;) {
    const data: ItemPage = await graphql<ItemPage>(connection, ITEM_PAGE, { project, cursor })
    collected.push(
      ...data.node.items.nodes.flatMap((item) => {
        if (!item.content) return []
        // Only a draft issue has an editable body; an issue is edited elsewhere.
        const draftId = item.content.__typename === "DraftIssue" ? item.content.id : undefined
        return [
          {
            id: item.id,
            draftId,
            title: item.content.title,
            body: item.content.body,
            status: item.fieldValueByName?.name,
          },
        ]
      }),
    )
    if (!data.node.items.pageInfo.hasNextPage) return collected
    cursor = data.node.items.pageInfo.endCursor
  }
}

async function setStatus(connection: Connection, project: string, item: string, field: string, option: string) {
  await graphql(
    connection,
    `mutation($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
    }`,
    { input: { projectId: project, itemId: item, fieldId: field, value: { singleSelectOptionId: option } } },
  )
}

async function setBody(connection: Connection, draft: string, body: string) {
  await graphql(
    connection,
    `mutation($input: UpdateProjectV2DraftIssueInput!) {
      updateProjectV2DraftIssue(input: $input) { draftIssue { id } }
    }`,
    { input: { draftIssueId: draft, body } },
  )
}

async function released(connection: Connection, version: string) {
  const response = await fetch(`https://api.github.com/repos/${connection.repo}/releases/tags/v${version}`, {
    headers: headers(connection),
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Cannot read release v${version}: ${response.status} ${response.statusText}`)
  const release = (await response.json()) as { draft: boolean }
  return !release.draft
}

/** A merge only advances work: Done is never undone and never inferred here. */
async function progress(connection: Connection, number: number) {
  const pullResponse = await fetch(`https://api.github.com/repos/${connection.repo}/pulls/${number}`, {
    headers: headers(connection),
  })
  if (!pullResponse.ok) throw new Error(`Cannot read #${number}: ${pullResponse.status} ${pullResponse.statusText}`)
  const pull = (await pullResponse.json()) as { number: number; title: string; body: string | null; html_url: string }

  const project = await board(connection)
  const known = new Set(project.items.flatMap((item) => itemCode(item.title) ?? []))
  const codes = roadmapCodes(pull, known)
  if (codes.length === 0) {
    console.log(`#${pull.number} names no tracked roadmap code; nothing to update`)
    return
  }

  console.log(`#${pull.number} names ${codes.join(", ")}`)
  let changed = 0
  for (const code of codes) {
    for (const item of project.items.filter((candidate) => itemCode(candidate.title) === code)) {
      if (item.status === "Done") {
        console.log(`${code}: already Done, leaving it alone`)
        continue
      }
      if (item.status !== "In Progress") {
        const option = project.option.get("In Progress")
        if (!option) throw new Error('the project has no "In Progress" option')
        console.log(`${code}: ${item.status ?? "no status"} -> In Progress`)
        if (!connection.dryRun) await setStatus(connection, project.id, item.id, project.fieldId, option)
        changed++
      }
      const body = withEvidence(item.body, { number: pull.number, url: pull.html_url })
      if (!item.draftId || body === item.body) {
        console.log(`${code}: no missing evidence to record`)
        continue
      }
      console.log(`${code}: recording #${pull.number} as evidence`)
      if (!connection.dryRun) await setBody(connection, item.draftId, body)
      changed++
    }
  }
  console.log(connection.dryRun ? `dry run: ${changed} change(s) planned` : `${changed} change(s) applied`)
}

/** Published acceptance records are the only way an item reaches Done. */
async function acceptance(connection: Connection) {
  const files = [
    ...(await Array.fromAsync(new Bun.Glob("docs/**/*.md").scan("."))),
    ...(await Array.fromAsync(new Bun.Glob("specs/**/*.md").scan("."))),
  ]
  const records = (
    await Promise.all(files.map(async (file) => acceptanceRecords(await Bun.file(file).text())))
  ).flat()
  if (records.length === 0) {
    console.log("no acceptance records are committed; nothing to do")
    return
  }

  const project = await board(connection)
  const done = project.option.get("Done")
  if (!done) throw new Error('the project has no "Done" option')

  const published = new Map<string, boolean>()
  let changed = 0
  for (const record of records) {
    if (!published.has(record.version)) {
      published.set(record.version, await released(connection, record.version))
    }
    if (!published.get(record.version)) {
      console.log(`${record.code}: v${record.version} is not published yet, keeping its status`)
      continue
    }
    const item = project.items.find((candidate) => itemCode(candidate.title) === record.code)
    if (!item) {
      console.log(`${record.code}: no board item carries this code`)
      continue
    }
    if (item.status === "Done") continue
    console.log(`${record.code}: ${item.status ?? "no status"} -> Done (v${record.version})`)
    if (!connection.dryRun) await setStatus(connection, project.id, item.id, project.fieldId, done)
    changed++
  }
  console.log(connection.dryRun ? `dry run: ${changed} change(s) planned` : `${changed} change(s) applied`)
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2)
  const token = process.env.ROADMAP_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) {
    console.error("ROADMAP_TOKEN or GITHUB_TOKEN environment variable is required")
    process.exit(1)
  }
  const connection: Connection = {
    token,
    repo: process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? "oxdingzg/miao",
    owner: process.env.ROADMAP_OWNER ?? "oxdingzg",
    ownerType: process.env.ROADMAP_OWNER_TYPE ?? "user",
    project: Number(process.env.ROADMAP_PROJECT ?? 1),
    dryRun: rest.includes("--dry-run"),
  }
  if (mode === "progress") {
    const at = rest.indexOf("--pr")
    const number = at === -1 ? Number.NaN : Number(rest[at + 1])
    if (!Number.isInteger(number) || number <= 0) throw new Error("progress needs --pr <number>")
    return progress(connection, number)
  }
  if (mode === "acceptance") return acceptance(connection)
  throw new Error("usage: roadmap-status.ts <progress --pr N | acceptance> [--dry-run]")
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error("Error:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
