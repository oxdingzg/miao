import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { builtinConnectors } from "../src/builtin"
import { loadConnectors, localPath } from "../src/load"

const fixture = path.join(import.meta.dir, "fixtures", "echo-connector.ts")

test("loads connectors from a local module path and installs npm specs through the caller", async () => {
  const installs: string[] = []
  const result = await loadConnectors({
    builtins: builtinConnectors,
    specs: ["./fixtures/echo-connector.ts", "miao-connector-missing"],
    cwd: import.meta.dir,
    install: async (spec) => {
      installs.push(spec)
      throw new Error(`cannot install ${spec} offline`)
    },
  })
  expect(result.connectors.map((connector) => connector.id)).toEqual(["wechat", "qq", "echo"])
  expect(installs).toEqual(["miao-connector-missing"])
  expect(result.errors).toEqual([
    { spec: "miao-connector-missing", error: "cannot install miao-connector-missing offline" },
  ])
})

test("refuses duplicate ids and modules without connectors", async () => {
  const result = await loadConnectors({
    builtins: builtinConnectors,
    specs: [fixture, fixture, path.join(import.meta.dir, "..", "src", "file.ts")],
    install: async () => {
      throw new Error("unused")
    },
  })
  expect(result.connectors.map((connector) => connector.id)).toEqual(["wechat", "qq", "echo"])
  expect(result.errors.map((error) => error.error)).toEqual([
    '连接器 id "echo" 已被占用，已跳过',
    "模块没有导出 defineConnector(...) 定义的连接器",
  ])
})

test("tells local paths from npm package names", () => {
  expect(localPath("/abs/x.js", "/cwd")).toBe("/abs/x.js")
  expect(localPath("./x.js", "/cwd")).toBe("/cwd/x.js")
  expect(localPath("~/x.js", "/cwd")).toBe(path.join(os.homedir(), "x.js"))
  expect(localPath("file:///tmp/x.js", "/cwd")).toBe("/tmp/x.js")
  expect(localPath("miao-connector-dingtalk", "/cwd")).toBeUndefined()
  expect(localPath("@scope/miao-connector", "/cwd")).toBeUndefined()
})
