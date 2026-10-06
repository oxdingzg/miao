/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_todo_clobber"

const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "todo clobber",
  agent: "build",
  model: { id: "model", providerID: "test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory },
  subpath: "",
}

const oldTodos = [{ content: "old", status: "pending", priority: "low" }]
const newTodos = [{ content: "new", status: "in_progress", priority: "high" }]

