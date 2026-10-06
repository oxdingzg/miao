import { describe, expect, it } from "bun:test"
import { PermissionClassifier } from "@miao/core/permission/classifier"

const worktree = "/project"

describe("PermissionClassifier", () => {
  describe("edit", () => {
    it("approves workspace paths", () => {
      expect(PermissionClassifier.edit(["/project/src/a.ts", "/project/README.md"], worktree)).toBe("safe")
    })

    it("rejects paths outside the worktree", () => {
      expect(PermissionClassifier.edit(["/etc/hosts"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit(["/project/../secrets.txt"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit([], worktree)).toBe("unknown")
    })

    it("rejects protected paths", () => {
      expect(PermissionClassifier.edit(["/project/.git/config"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit(["/project/.env"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit(["/project/.env.local"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit(["/project/server.key"], worktree)).toBe("unknown")
      expect(PermissionClassifier.edit(["/home/u/.ssh/known_hosts"], worktree)).toBe("unknown")
    })
  })

  describe("bash", () => {
    it("approves read-only commands", async () => {
      expect(await PermissionClassifier.bash(["ls -la"])).toBe("safe")
      expect(await PermissionClassifier.bash(["cat src/a.ts | grep foo"])).toBe("safe")
      expect(await PermissionClassifier.bash(["git status"])).toBe("safe")
      expect(await PermissionClassifier.bash(["git log --oneline -5"])).toBe("safe")
      expect(await PermissionClassifier.bash(["echo hi && wc -c"])).toBe("safe")
      expect(await PermissionClassifier.bash(["git"])).toBe("safe")
    })

    it("rejects writes and execution", async () => {
      expect(await PermissionClassifier.bash(["rm -rf x"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["echo hi > out.txt"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["git branch dev"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["git commit -m x"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["sudo ls"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["ls && rm x"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["bun script.ts"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["find . -delete"])).toBe("unknown")
    })

    it("rejects protected path arguments", async () => {
      expect(await PermissionClassifier.bash(["cat .env"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["grep x /project/.git/config"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["grep --include=.env foo ."])).toBe("unknown")
    })

    it("rejects unparseable input and stdin scripts", async () => {
      expect(await PermissionClassifier.bash(["ls 'unterminated"])).toBe("unknown")
      expect(await PermissionClassifier.bash(["cat <<stdin\nscript"])).toBe("unknown")
      expect(await PermissionClassifier.bash([])).toBe("unknown")
    })
  })
})
