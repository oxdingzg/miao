import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@miao/core/permission"
import { ShellApproval } from "@miao/core/shell/approval"

describe("ShellApproval.bash", () => {
  // Expected values follow the V1 shell tool: one resource per command and the
  // BashArity prefix of each command plus " *" as the saved rule.
  test.each([
    ["git status", ["git status"], ["git status *"]],
    ["git status --short", ["git status --short"], ["git status *"]],
    ["git checkout -b feature", ["git checkout -b feature"], ["git checkout *"]],
    ["git stash pop", ["git stash pop"], ["git stash pop *"]],
    ["npm install lodash", ["npm install lodash"], ["npm install *"]],
    ["npm run dev -- --port 3000", ["npm run dev -- --port 3000"], ["npm run dev *"]],
    ["bun install", ["bun install"], ["bun install *"]],
    ["bun run typecheck", ["bun run typecheck"], ["bun run typecheck *"]],
    ["bun test test/foo.test.ts", ["bun test test/foo.test.ts"], ["bun test *"]],
    ["docker ps -a", ["docker ps -a"], ["docker ps *"]],
    ["docker compose up -d", ["docker compose up -d"], ["docker compose up *"]],
    ["kubectl get pods -n kube-system", ["kubectl get pods -n kube-system"], ["kubectl get *"]],
    ["kubectl rollout restart deploy/api", ["kubectl rollout restart deploy/api"], ["kubectl rollout restart *"]],
    ["ls -la", ["ls -la"], ["ls *"]],
    ["python script.py", ["python script.py"], ["python script.py *"]],
  ])("%p saves the V1 prefix rule", async (command, resources, save) => {
    expect(await ShellApproval.bash(command)).toEqual({ resources, save })
  })

  test("splits lists and pipelines into one resource and one rule per command", async () => {
    expect(await ShellApproval.bash('git add . && git commit -m "wip"')).toEqual({
      resources: ["git add .", 'git commit -m "wip"'],
      save: ["git add *", "git commit *"],
    })
    expect(await ShellApproval.bash("ls -la | grep foo; echo done")).toEqual({
      resources: ["ls -la", "grep foo", "echo done"],
      save: ["ls *", "grep *", "echo *"],
    })
  })

  test("asks for commands inside substitutions and keeps redirections in the resource", async () => {
    expect(await ShellApproval.bash("echo $(rm -rf /tmp/x)")).toEqual({
      resources: ["echo $(rm -rf /tmp/x)", "rm -rf /tmp/x"],
      save: ["echo *", "rm *"],
    })
    expect(await ShellApproval.bash("echo hi > out.txt")).toEqual({
      resources: ["echo hi > out.txt"],
      save: ["echo *"],
    })
  })

  test("skips directory changes, and leaves a command with nothing else to exact approval", async () => {
    expect(await ShellApproval.bash("cd src && bun test")).toEqual({ resources: ["bun test"], save: ["bun test *"] })
    expect(await ShellApproval.bash("cd src")).toBeUndefined()
    expect(await ShellApproval.bash("FOO=1")).toBeUndefined()
  })

  test("leaves a command that does not parse to exact approval", async () => {
    expect(await ShellApproval.bash("echo )")).toBeUndefined()
    expect(await ShellApproval.bash("git status; rm -rf / ((")).toBeUndefined()
  })

  test("existing rules keep matching the split resources", async () => {
    const allowed = async (command: string, rules: PermissionV2.Ruleset) => {
      const split = await ShellApproval.bash(command)
      return (split?.resources ?? [command]).map((resource) => PermissionV2.evaluate("bash", resource, rules).effect)
    }
    // A rule saved before this change named the whole single command.
    expect(await allowed("git status", [{ action: "bash", resource: "git status", effect: "allow" }])).toEqual([
      "allow",
    ])
    // Saved prefix rules and configured patterns apply to each command.
    const saved: PermissionV2.Ruleset = [
      { action: "bash", resource: "git add *", effect: "allow" },
      { action: "bash", resource: "git commit *", effect: "allow" },
    ]
    expect(await allowed('git add . && git commit -m "wip"', saved)).toEqual(["allow", "allow"])
    expect(await allowed("git add . && rm -rf build", saved)).toEqual(["allow", "ask"])
    expect(await allowed("cd build && rm -rf .", [{ action: "bash", resource: "rm *", effect: "deny" }])).toEqual([
      "deny",
    ])
    // A saved prefix also covers the bare command.
    expect(await allowed("git status", [{ action: "bash", resource: "git status *", effect: "allow" }])).toEqual([
      "allow",
    ])
  })
})
