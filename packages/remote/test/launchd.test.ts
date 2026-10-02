import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Label, plist } from "../src/launchd"

test("writes a launchd agent that plutil accepts and escapes values", async () => {
  const text = plist({
    program: ["/opt/miao & co/bin/miao", "remote"],
    workingDirectory: "/Users/me",
    logFile: "/Users/me/.local/share/miao/log/remote.log",
    environment: { PATH: "/usr/bin:/bin", HOME: "/Users/me" },
  })
  expect(text).toContain(`<string>${Label}</string>`)
  expect(text).toContain("<string>/opt/miao &amp; co/bin/miao</string>")
  expect(text).toContain("<key>SuccessfulExit</key>")
  if (process.platform !== "darwin") return
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-launchd-"))
  try {
    const file = path.join(directory, "agent.plist")
    await Bun.write(file, text)
    const lint = Bun.spawnSync(["plutil", "-lint", file])
    expect(lint.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
