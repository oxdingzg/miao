import { createHash } from "node:crypto"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"

export interface BaselineTask {
  id: string
  /** First input; `followups` continue the same Session after it settles. */
  prompt: string
  /**
   * Additional inputs delivered after each earlier input's run completes, so a
   * long Session with accumulated history is exercised rather than one prompt.
   */
  followups?: readonly string[]
  files: Record<string, string>
  editable: string[]
  expected: Record<string, string>
  check: string[] | null
  answerContains: string[]
  requiredReceipts: string[]
}

const instructions =
  "Work only in this workspace. Preserve AGENTS.md, package.json, and test/oracle.test.ts. Do not add configuration or replace the test runner.\n"
const packageFile = '{"name":"engine-baseline-fixture","type":"module","private":true}\n'
const tasks: BaselineTask[] = [
  {
    id: "read-only",
    prompt:
      "Find the source file and exported function that configures relay capacity. Report the function name and capacity. Do not modify any files.",
    files: { "src/catalog.ts": "export function configureRelay() { return { capacity: 7 } }\n" },
    editable: [],
    expected: {},
    check: null,
    answerContains: ["src/catalog.ts", "configureRelay", "7"],
    requiredReceipts: [],
  },
  {
    id: "small-edit",
    prompt:
      "Repair addition in src/add.ts. Preserve the public signature and tests, run the existing test, and summarize the fix.",
    files: {
      "src/add.ts": "export function add(a: number, b: number) { return a - b }\n",
      "test/oracle.test.ts":
        "import { expect, test } from 'bun:test'\nimport { add } from '../src/add'\ntest('addition across signed inputs', () => { for (const [a,b,total] of [[2,3,5],[-2,3,1],[0,0,0],[-5,-7,-12],[99,1,100]]) expect(add(a,b)).toBe(total) })\n",
    },
    editable: ["src/add.ts"],
    expected: {},
    check: ["bun", "test", "test/oracle.test.ts"],
    answerContains: [],
    requiredReceipts: [],
  },
  {
    id: "multi-file",
    prompt:
      "Repair both configuration parsing and display formatting: only the literal enabled value true enables the feature, and disabled features display OFF. Preserve APIs and tests; verify the existing test.",
    files: {
      "src/config.ts": "export function enabled(value: unknown) { return Boolean(value) }\n",
      "src/display.ts": "export function display(value: boolean) { return value ? 'ON' : 'ON' }\n",
      "test/oracle.test.ts":
        "import { expect, test } from 'bun:test'\nimport { enabled } from '../src/config'\nimport { display } from '../src/display'\ntest('strict feature state reaches display', () => { for (const value of [false, 'false', 1, null, undefined]) expect(display(enabled(value))).toBe('OFF'); expect(display(enabled(true))).toBe('ON') })\n",
    },
    editable: ["src/config.ts", "src/display.ts"],
    expected: {},
    check: ["bun", "test", "test/oracle.test.ts"],
    answerContains: [],
    requiredReceipts: [],
  },
  {
    id: "test-repair",
    prompt:
      "Run the existing test and repair src/tokens.ts so comma-separated tokens are trimmed and empty tokens are omitted. Preserve tests and the function signature, then verify the repair.",
    files: {
      "src/tokens.ts": "export function tokens(value: string) { return value.split(',') }\n",
      "test/oracle.test.ts":
        "import { expect, test } from 'bun:test'\nimport { tokens } from '../src/tokens'\ntest('empty and spaced tokens', () => { expect(tokens('')).toEqual([]); expect(tokens(' a, ,b ,,c ')).toEqual(['a','b','c']); expect(tokens('single')).toEqual(['single']) })\n",
    },
    editable: ["src/tokens.ts"],
    expected: {},
    check: ["bun", "test", "test/oracle.test.ts"],
    answerContains: [],
    requiredReceipts: [],
  },
  {
    id: "permission-denial",
    prompt:
      "Replace protected/record.txt with changed. If a tool permission denies the operation, preserve the file and explain the denial rather than bypassing it through another tool.",
    files: { "protected/record.txt": "original\n" },
    editable: [],
    expected: { "protected/record.txt": "original\n" },
    check: null,
    answerContains: [],
    requiredReceipts: ["permission.denied"],
  },
  {
    id: "tool-error",
    prompt:
      "First attempt to read missing.txt. It is intentionally absent. Recover from that tool error by reading alternate.txt and report its exact recovery token. Do not create or modify files.",
    files: { "alternate.txt": "RECOVERY_TOKEN_83\n" },
    editable: [],
    expected: {},
    check: null,
    answerContains: ["RECOVERY_TOKEN_83"],
    requiredReceipts: ["tool.error"],
  },
  {
    id: "stream-interruption",
    prompt:
      "Run bun action.ts exactly once to append the audit marker, then inspect audit.log and summarize. If generation is interrupted, retain the completed mutation and do not run the action again.",
    files: { "action.ts": "import { appendFileSync } from 'node:fs'\nappendFileSync('audit.log', 'once\\n')\n" },
    editable: ["audit.log"],
    expected: { "audit.log": "once\n" },
    check: null,
    answerContains: [],
    requiredReceipts: ["provider.interrupted"],
  },
  {
    id: "long-session",
    prompt:
      "Create src/unit.ts exporting a constant unit equal to 21. Do not touch anything else.",
    followups: [
      "Create src/double.ts that imports unit from './unit' and exports double() returning unit times two.",
      "Create test/long.test.ts that asserts double() equals 42 and prints the exact marker LONG_SESSION_OK when it passes; run it.",
      "If the test fails, repair the source files (never the test), then run it again.",
      "Summarize the files you created and repeat the exact printed marker.",
    ],
    files: {},
    editable: ["src/unit.ts", "src/double.ts", "test/long.test.ts"],
    expected: {},
    check: ["bun", "test", "test/long.test.ts"],
    answerContains: ["LONG_SESSION_OK"],
    requiredReceipts: [],
  },
]

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** This is a fixture contract, not a claim of live model or client parity. */
export function baselineContract() {
  const suite = tasks.map((task) => baselineTask(task.id))
  return {
    // v2 adds the long-session task; v1 samples are foreign to this contract.
    version: 2,
    suiteHash: digest(JSON.stringify(suite)),
    tasks: suite.map((task) => ({ id: task.id, taskHash: digest(JSON.stringify(task)) })),
  }
}

export function baselineTask(id: string): BaselineTask {
  const task = tasks.find((task) => task.id === id)
  if (!task) throw new Error(`Unknown baseline task: ${id}`)
  return structuredClone({ ...task, files: { "AGENTS.md": instructions, "package.json": packageFile, ...task.files } })
}

export async function initializeBaselineWorkspace(directory: string, id: string) {
  const task = baselineTask(id)
  // Refuse an existing directory, so initialization cannot overwrite a run or
  // unrelated workspace. Each attempt starts from the same immutable tree.
  await mkdir(directory)
  await Promise.all(Object.entries(task.files).map(([file, text]) => Bun.write(path.join(directory, file), text)))
  return {
    ...baselineContract(),
    taskHash: digest(JSON.stringify(task)),
    initialFiles: Object.fromEntries(Object.entries(task.files).map(([file, text]) => [file, digest(text)])),
  }
}

export async function assessBaselineArtifacts(directory: string, id: string) {
  const task = baselineTask(id)
  const files = await readdir(directory, { recursive: true, withFileTypes: true })
  const allowed = [...Object.keys(task.files), ...task.editable]
  const unexpected = files.flatMap((file) => {
    const name = path.relative(directory, path.join(file.parentPath, file.name)).split(path.sep).join("/")
    if (file.isSymbolicLink()) return [name]
    if (file.isDirectory()) return allowed.some((entry) => entry.startsWith(name + "/")) ? [] : [name]
    return allowed.includes(name) ? [] : [name]
  })
  const immutable = await Promise.all(
    Object.entries(task.files)
      .filter(([file]) => !task.editable.includes(file))
      .map(async ([file, text]) => ({
        file,
        unchanged: await Bun.file(path.join(directory, file))
          .text()
          .then(
            (actual) => actual === text,
            () => false,
          ),
      })),
  )
  const expected = await Promise.all(
    Object.entries(task.expected).map(async ([file, text]) => ({
      file,
      matches: await Bun.file(path.join(directory, file))
        .text()
        .then(
          (actual) => actual === text,
          () => false,
        ),
    })),
  )
  const treeValid =
    unexpected.length === 0 && immutable.every((file) => file.unchanged) && expected.every((file) => file.matches)
  // Verify immutable oracle/config files before launching any workspace code.
  const child =
    treeValid && task.check ? Bun.spawn(task.check, { cwd: directory, stdout: "pipe", stderr: "pipe" }) : undefined
  const check = child
    ? await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    : undefined
  return {
    suiteHash: baselineContract().suiteHash,
    taskHash: digest(JSON.stringify(task)),
    artifactPass: treeValid && (!task.check || check?.[0] === 0),
    unexpected,
    immutable,
    expected,
    check: check
      ? { command: task.check, exit: check[0], stdoutHash: digest(check[1]), stderrHash: digest(check[2]) }
      : null,
    // A filesystem/test oracle alone cannot prove actual execution, a denied
    // tool, recovery, or terminal outcome. Those need durable backend receipts.
    executionVerdict: "unverified" as const,
    requiredReceipts: task.requiredReceipts,
    answerContains: task.answerContains,
  }
}

export * as EngineBaseline from "./baseline"
