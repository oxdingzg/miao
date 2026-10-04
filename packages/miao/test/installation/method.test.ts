import { describe, expect, test } from "bun:test"
import { isDirectInstall } from "../../src/installation/method"

describe("direct installation detection", () => {
  test("recognizes the Windows installer executable and launcher layout", () => {
    expect(isDirectInstall(String.raw`C:\Users\dingz\AppData\Local\Programs\Miao\miao-bin.exe`, "win32")).toBe(true)
    expect(isDirectInstall(String.raw`C:\Users\dingz\AppData\Local\Programs\Miao\miao.exe`, "win32")).toBe(true)
    expect(isDirectInstall("C:/Users/user/AppData/Local/Programs/MIAO/MIAO-BIN.EXE", "win32")).toBe(true)
  })

  test("recognizes script-installed binaries across platforms", () => {
    expect(isDirectInstall(String.raw`C:\Users\user\.MIAO\bin\miao.exe`, "win32")).toBe(true)
    expect(isDirectInstall("/home/user/.miao/bin/miao", "linux")).toBe(true)
    expect(isDirectInstall("/home/user/.local/bin/miao", "linux")).toBe(true)
  })

  test("leaves package-manager and arbitrary executables to method discovery", () => {
    expect(isDirectInstall(String.raw`C:\Users\user\scoop\apps\miao\current\miao.exe`, "win32")).toBe(false)
    expect(isDirectInstall(String.raw`C:\workspace\miao-bin.exe`, "win32")).toBe(false)
    expect(isDirectInstall("/opt/homebrew/bin/miao", "darwin")).toBe(false)
    expect(isDirectInstall("/home/user/.miao/bin-backup/miao", "linux")).toBe(false)
  })
})
