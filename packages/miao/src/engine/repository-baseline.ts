import { createHash } from "node:crypto"
import { lstat, mkdir, readlink } from "node:fs/promises"
import path from "node:path"

export interface RepositorySource {
  repository: string
  commit: string
  tree: string
  archiveSha256: string
}

export interface RepositoryProfile {
  provider: string
  model: string
  parameters: Record<string, unknown>
  agent: string
  permissionHash: string
  toolSurfaceHash: string
  repetitions: number
  maxElapsedMs: number
  maxAttempts: number
  maxCost: number | null
}

type Tree = Record<string, { kind: "directory" | "file" | "symlink" | "special"; hash: string; executable: boolean }>

const source: RepositorySource = {
  repository: "oxdingzg/miao",
  commit: "8ac61a6629b88939afec35d907b5570a6ce5e37a",
  tree: "c94f5e0ebfce193819d4cbecfe5ab6758327bb1f",
  archiveSha256: "e583d1dc235852ac06506b9db72aeb6d8ce426b913b6e4c37e149f4fd80f1362",
}

const foreignSource: RepositorySource = {
  repository: "sindresorhus/escape-string-regexp",
  commit: "a7f7dabaf336bda98d2166848af15d9168b10bcf",
  tree: "d61e3c09b705663f24473a8b05242a3e124eef18",
  archiveSha256: "57e81aae81daa18b2d99fd47fd124252cc5eca03786cb4d2187cf7d7dc6caf3f",
}

export function repositoryBaselineSource(repository = source.repository): RepositorySource {
  if (repository === source.repository) return structuredClone(source)
  if (repository === foreignSource.repository) return structuredClone(foreignSource)
  throw new Error(`Unknown frozen repository: ${repository}`)
}

const tasks = [
  {
    id: "repository-lazy-cache",
    prompt:
      "In this frozen miao repository, core lazy initialization returns undefined without calling its factory. Find and repair the owning implementation. Cache successful results, including undefined and false, exactly once. Preserve public signatures and all unrelated files.",
    file: "packages/core/src/util/lazy.ts",
    before: "let loaded = false",
    seeded: "let loaded = true",
    check: `import { strict } from "node:assert";
import { lazy } from "./packages/core/src/util/lazy.ts";
for (const expected of [undefined, false, 0, { value: 7 }]) {
  let calls = 0;
  const value = lazy(() => { calls++; return expected });
  strict.equal(value(), expected);
  strict.equal(value(), expected);
  strict.equal(calls, 1);
}`,
  },
  {
    id: "repository-sorted-lookup",
    prompt:
      "In this frozen miao repository, core lookup in sorted collections fails at the edges. Find and repair the owning search implementation. Preserve insertion indexes for absent keys, logarithmic comparisons, public exports, and all unrelated files.",
    file: "packages/core/src/util/binary.ts",
    before: "else if (midId < id)",
    seeded: "else if (midId > id)",
    check: `import { strict } from "node:assert";
import { Binary } from "./packages/core/src/util/binary.ts";
const values = Array.from({length: 1024}, (_, i) => ({id: String(i * 2).padStart(5, "0")}));
for (const index of [0, 1, 17, 511, 1023]) {
  let calls = 0;
  strict.deepEqual(Binary.search(values, values[index].id, value => { calls++; return value.id }), {found:true,index});
  strict.ok(calls <= 11);
}
for (const [key, index] of [["00001",1],["00033",17],["99999",1024]])
  strict.deepEqual(Binary.search(values, key, value => value.id), {found:false,index});
strict.deepEqual(Binary.search([], "x", value => value.id), {found:false,index:0});
const inserted = [{id:"a"},{id:"c"}];
strict.equal(Binary.insert(inserted, {id:"b"}, value => value.id), inserted);
strict.deepEqual(inserted.map(value => value.id), ["a","b","c"]);`,
  },
] as const

const foreignTasks = [
  {
    id: "repository-unicode-escaping",
    prompt:
      "In this frozen JavaScript utility repository, escaping a hyphen produces an unintended range when used inside a Unicode character class. Find and repair the owning implementation. Preserve literal matching, input validation, exports, and all unrelated files.",
    file: "index.js",
    before: String.raw`.replace(/-/g, '\\x2d')`,
    seeded: ".replace(/-/g, '-')",
    check: String.raw`import { strict } from "node:assert";
import escape from "./index.js";
strict.equal(escape("-"), "\\x2d");
for (const value of ["", "plain", "a-z", "[x].*+?^$(){}|", "back\\slash", "你好🙂"]) {
  const pattern = new RegExp("^(?:" + escape(value) + ")$", "u");
  strict.equal(pattern.test(value), true);
  strict.equal(pattern.test(value + "extra"), false);
}
const character = new RegExp("^[" + escape("a-z") + "]$", "u");
for (const value of ["a", "-", "z"]) strict.equal(character.test(value), true);
strict.equal(character.test("m"), false);
strict.throws(() => escape(7), TypeError);`,
  },
] as const

function tasksFor(snapshot: RepositorySource) {
  if (snapshot.repository === source.repository) return tasks
  if (snapshot.repository === foreignSource.repository) return foreignTasks
  throw new Error(`Unknown frozen repository: ${snapshot.repository}`)
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Separate contract: existing suite-v6 identities and reports remain frozen. */
export function repositoryBaselineContract(profile: RepositoryProfile, snapshot: RepositorySource = source) {
  if (
    !/^[a-f0-9]{40}$/.test(snapshot.commit) ||
    !/^[a-f0-9]{40}$/.test(snapshot.tree) ||
    !/^[a-f0-9]{64}$/.test(snapshot.archiveSha256)
  )
    throw new Error("Invalid frozen repository source")
  if (
    !profile.provider ||
    !profile.model ||
    !profile.agent ||
    !/^[a-f0-9]{64}$/.test(profile.permissionHash) ||
    !/^[a-f0-9]{64}$/.test(profile.toolSurfaceHash)
  )
    throw new Error("Missing frozen model or authority profile")
  if (
    !Number.isSafeInteger(profile.repetitions) ||
    profile.repetitions < 1 ||
    !Number.isSafeInteger(profile.maxAttempts) ||
    profile.maxAttempts < 1 ||
    !Number.isFinite(profile.maxElapsedMs) ||
    profile.maxElapsedMs <= 0 ||
    (profile.maxCost !== null && (!Number.isFinite(profile.maxCost) || profile.maxCost < 0))
  )
    throw new Error("Invalid frozen repetition or budget")
  const contract = {
    version: 1,
    source: snapshot,
    profile,
    tasks: tasksFor(snapshot).map((task) => ({ ...task, verifierHash: digest(task.check) })),
  }
  return structuredClone({ ...contract, suiteHash: digest(JSON.stringify(contract)) })
}

export async function initializeRepositoryBaseline(input: {
  archive: string
  directory: string
  task: string
  contract: ReturnType<typeof repositoryBaselineContract>
}) {
  validateContract(input.contract)
  const task = input.contract.tasks.find((task) => task.id === input.task)
  if (!task) throw new Error(`Unknown repository task: ${input.task}`)
  if (Bun.file(input.archive).size > 128 * 1024 * 1024) throw new Error("Repository archive exceeds the fixture budget")
  if (digest(new Uint8Array(await Bun.file(input.archive).arrayBuffer())) !== input.contract.source.archiveSha256)
    throw new Error("Repository archive does not match the frozen source")
  await mkdir(input.directory)
  const child = Bun.spawn(["tar", "-xf", path.resolve(input.archive), "-C", input.directory], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exit !== 0) throw new Error(`Cannot extract frozen repository: ${stderr}`)
  const original = await Bun.file(path.join(input.directory, task.file)).text()
  if (original.split(task.before).length !== 2) throw new Error("Seed no longer matches the frozen source exactly once")
  await Bun.write(path.join(input.directory, task.file), original.replace(task.before, task.seeded))
  const initialTree = await snapshotTree(input.directory)
  return {
    suiteHash: input.contract.suiteHash,
    taskHash: digest(JSON.stringify(task)),
    source: input.contract.source,
    profile: input.contract.profile,
    task: task.id,
    initialTree,
    initialTreeHash: digest(JSON.stringify(initialTree)),
  }
}

export async function assessRepositoryBaseline(input: {
  directory: string
  metadata: Awaited<ReturnType<typeof initializeRepositoryBaseline>>
  contract: ReturnType<typeof repositoryBaselineContract>
}) {
  validateContract(input.contract)
  if (digest(JSON.stringify(input.metadata.initialTree)) !== input.metadata.initialTreeHash)
    throw new Error("Repository fixture metadata changed")
  const task = input.contract.tasks.find((task) => task.id === input.metadata.task)
  if (
    !task ||
    input.metadata.suiteHash !== input.contract.suiteHash ||
    input.metadata.taskHash !== digest(JSON.stringify(task))
  )
    throw new Error("Repository fixture contract mismatch")
  const current = await snapshotTree(input.directory)
  const changed = [...new Set([...Object.keys(input.metadata.initialTree), ...Object.keys(current)])]
    .filter((file) => JSON.stringify(input.metadata.initialTree[file]) !== JSON.stringify(current[file]))
    .sort()
  const unexpected = changed.filter((file) => file !== task.file)
  const treeValid =
    unexpected.length === 0 &&
    current[task.file]?.kind === "file" &&
    current[task.file].executable === input.metadata.initialTree[task.file].executable
  const child = treeValid
    ? Bun.spawn([process.execPath, "--eval", task.check], { cwd: input.directory, stdout: "pipe", stderr: "pipe" })
    : undefined
  const timer = child ? setTimeout(() => child.kill(), 10_000) : undefined
  const result = child
    ? await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    : undefined
  clearTimeout(timer)
  return {
    suiteHash: input.contract.suiteHash,
    taskHash: input.metadata.taskHash,
    source: input.contract.source,
    artifactPass: treeValid && result?.[0] === 0,
    changed,
    unexpected,
    check: result
      ? {
          exit: result[0],
          stdoutHash: digest(result[1]),
          stderrHash: digest(result[2]),
          verifierHash: task.verifierHash,
        }
      : null,
    executionVerdict: "unverified" as const,
  }
}

function validateContract(contract: ReturnType<typeof repositoryBaselineContract>) {
  const frozen = {
    version: contract.version,
    source: contract.source,
    profile: contract.profile,
    tasks: contract.tasks,
  }
  if (
    digest(JSON.stringify(frozen)) !== contract.suiteHash ||
    JSON.stringify(contract.tasks) !==
      JSON.stringify(tasksFor(contract.source).map((task) => ({ ...task, verifierHash: digest(task.check) })))
  )
    throw new Error("Repository fixture contract changed")
}

async function snapshotTree(directory: string): Promise<Tree> {
  const tree: Tree = {}
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: directory,
    dot: true,
    onlyFiles: false,
    followSymlinks: false,
  })) {
    const stat = await lstat(path.join(directory, file))
    tree[file.split(path.sep).join("/")] = stat.isSymbolicLink()
      ? { kind: "symlink", hash: digest(await readlink(path.join(directory, file))), executable: false }
      : stat.isDirectory()
        ? { kind: "directory", hash: "", executable: false }
        : !stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024
          ? { kind: "special", hash: String(stat.size), executable: false }
          : {
              kind: "file",
              hash: digest(new Uint8Array(await Bun.file(path.join(directory, file)).arrayBuffer())),
              executable: (stat.mode & 0o111) !== 0,
            }
  }
  return tree
}

export * as RepositoryBaseline from "./repository-baseline"
