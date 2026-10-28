import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { commandSelection } from "../../src/cli/dispatch"
import { tmpdir } from "../fixture/fixture"

test("an existing absolute project selects the TUI without loading unrelated commands", async () => {
  await using tmp = await tmpdir()
  expect(await commandSelection([tmp.path, "--model", "openai/fixture"], ["serve", "run"])).toBe("default")
})

test("relative projects and directory symlinks use the invocation directory", async () => {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, "project"))
  await fs.symlink(
    path.join(tmp.path, "project"),
    path.join(tmp.path, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  )
  expect(await commandSelection(["./project"], ["serve"], tmp.path)).toBe("default")
  expect(await commandSelection(["./linked"], ["serve"], tmp.path)).toBe("default")
})

test("command names keep precedence over a same-named project directory", async () => {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, "serve"))
  expect(await commandSelection(["serve", "--port", "0"], ["serve"], tmp.path)).toEqual(["serve"])
})

test("missing paths and regular files retain full unknown-command handling", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "file"), "fixture")
  expect(await commandSelection(["./missing"], ["serve"], tmp.path)).toBe("all")
  expect(await commandSelection(["./file"], ["serve"], tmp.path)).toBe("all")
})

test("bare aliases retain their command handlers even when matching directories exist", async () => {
  await using tmp = await tmpdir()
  await Promise.all(["auth", "plug", "remote-control"].map((name) => fs.mkdir(path.join(tmp.path, name))))
  expect(await commandSelection(["auth", "list"], ["providers"], tmp.path)).toBe("all")
  expect(await commandSelection(["plug"], ["plugin"], tmp.path)).toBe("all")
  expect(await commandSelection(["remote-control", "status"], ["remote"], tmp.path)).toBe("all")
})

test("global help, version and a bare invocation retain their dispatch", async () => {
  expect(await commandSelection([], ["serve"])).toBe("default")
  expect(await commandSelection(["--help"], ["serve"])).toBe("all")
  expect(await commandSelection(["-h"], ["serve"])).toBe("all")
  expect(await commandSelection(["--version"], ["serve"])).toEqual([])
  expect(await commandSelection(["-v"], ["serve"])).toEqual([])
  expect(await commandSelection(["serve", "--help"], ["serve"])).toEqual(["serve"])
})
