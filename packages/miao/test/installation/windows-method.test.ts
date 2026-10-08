import { expect, test } from "bun:test"
import { isWindowsStandalone } from "../../src/installation/windows"

test("recognizes a standalone Windows installation in LocalAppData", () => {
  expect(
    isWindowsStandalone(
      "C:\\Users\\dingz\\AppData\\Local\\Programs\\Miao\\miao.exe",
      "C:\\Users\\dingz\\AppData\\Local",
    ),
  ).toBe(true)
  expect(isWindowsStandalone("c:/users/test/appdata/local/programs/MIAO/MIAO.EXE", "C:\\Users\\test\\AppData\\Local")).toBe(
    true,
  )
})

test("does not classify package manager or other executables as standalone", () => {
  const local = "C:\\Users\\test\\AppData\\Local"
  expect(isWindowsStandalone("C:\\Users\\test\\scoop\\apps\\miao\\current\\miao.exe", local)).toBe(false)
  expect(isWindowsStandalone(`${local}\\Programs\\Miao\\miao-bin.exe`, local)).toBe(false)
  expect(isWindowsStandalone(`${local}\\Programs\\Miao\\other\\miao.exe`, local)).toBe(false)
  expect(isWindowsStandalone(`${local}\\Programs\\Miao\\miao.exe`, "")).toBe(false)
})
