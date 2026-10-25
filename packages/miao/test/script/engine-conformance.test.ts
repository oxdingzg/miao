import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("conformance isolates placement and reads each engine's durable receipts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "miao-conformance-test-"))
  try {
    // A local CLI fixture exercises the harness's process, pipe and database
    // boundaries without depending on provider credentials or model behavior.
    const binary = path.join(directory, "fixture.ts")
    await Bun.write(
      binary,
      `#!/usr/bin/env bun
import { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const directory = args[args.indexOf("--dir") + 1]
const engine = args[args.indexOf("--engine") + 1]
if (!directory || realpathSync(directory) !== realpathSync(process.cwd()) || !["native", "ts"].includes(engine))
  throw new Error("fixture placement mismatch")
const id = "ses_fixture_" + engine + "_" + Date.now()
const file = engine === "native" ? path.join(process.env.MIAO_ENGINE_STORAGE, "engine.db") : process.env.MIAO_DB
const db = new Database(file, {create: true})
if (engine === "native") {
  db.exec("CREATE TABLE IF NOT EXISTS engine_session(id TEXT,title TEXT); CREATE TABLE IF NOT EXISTS engine_event(session_id TEXT,kind TEXT); CREATE TABLE IF NOT EXISTS engine_run(session_id TEXT,state TEXT)")
  db.query("INSERT INTO engine_session VALUES(?,?)").run(id, "Verified fixture title")
  db.query("INSERT INTO engine_event VALUES(?,?)").run(id, "usage")
  db.query("INSERT INTO engine_run VALUES(?,?)").run(id, process.env.CONFORMANCE_FIXTURE_INTERRUPTED ? "interrupted" : "completed")
} else {
  if (process.env.MIAO_ENGINE_STORAGE) throw new Error("TS fixture inherited native placement")
  db.exec("CREATE TABLE IF NOT EXISTS session(id TEXT,title TEXT); CREATE TABLE IF NOT EXISTS session_turn_usage(session_id TEXT)")
  db.query("INSERT INTO session VALUES(?,?)").run(id, "Verified fixture title")
  db.query("INSERT INTO session_turn_usage VALUES(?)").run(id)
}
db.close()
await Bun.write(Bun.stderr, "fixture diagnostic\\n".repeat(100000))
console.log(JSON.stringify({type:"step_finish", part:{sessionID:id, cost:0.01, tokens:{input:10, output:1}}}))
`,
    )
    await chmod(binary, 0o755)
    for (const interrupted of [false, true]) {
      const output = path.join(directory, interrupted ? "negative" : "positive")
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "../../../../script/engine-conformance.ts"),
          "--binary",
          binary,
          "--scenarios",
          "usage-priced,session-title",
          "--engines",
          interrupted ? "rust" : "ts,rust",
          "--data",
          output,
          "--storage",
          path.join(output, "storage"),
          "--segment-timeout",
          "5",
        ],
        {
          env: { ...process.env, CONFORMANCE_FIXTURE_INTERRUPTED: interrupted ? "1" : "" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(code).toBe(interrupted ? 1 : 0)
      expect(stdout).toContain(
        interrupted ? "native run ended as interrupted despite exit code 0" : "SUMMARY pass=4 fail=0",
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
