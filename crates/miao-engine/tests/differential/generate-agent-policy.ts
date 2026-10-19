import { ShellApproval } from "../../../../packages/core/src/shell/approval"
import { PermissionV2 } from "../../../../packages/core/src/permission"

// Golden decisions come from the real host evaluator. Rust consumes this corpus
// to pin the contract at the bridge, including last-match exceptions and the
// host's command-prefix and separator wildcard semantics.
const rules = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "read", resource: "*.env", effect: "ask" as const },
  { action: "read", resource: "*.env.example", effect: "allow" as const },
  { action: "edit", resource: ".miao/plans/*.md", effect: "allow" as const },
  { action: "bash", resource: "git status *", effect: "allow" as const },
  { action: "read", resource: "literal[1].txt", effect: "allow" as const },
  { action: "read", resource: "file?.txt", effect: "ask" as const },
]
const cases = [
  ["read", "src/file.ts"],
  ["read", "secret.env"],
  ["read", "nested/secret.env"],
  ["read", "nested\\secret.env"],
  ["read", "nested/secret.env.example"],
  ["edit", "src/file.ts"],
  ["edit", ".miao/plans/task.md"],
  ["edit", ".miao/plans/nested/task.md"],
  ["bash", "git status"],
  ["bash", "git status --short"],
  ["bash", "git status-other"],
  ["read", "literal[1].txt"],
  ["read", "file1.txt"],
  ["read", "file12.txt"],
  ["read", "line\nbreak.txt"],
  ["unknown", "anything"],
].map(([action, resource]) => ({ action, resource, expected: PermissionV2.evaluate(action, resource, rules).effect }))
const shells = await Promise.all(
  [
    "git status",
    "git status --short",
    "git status; rm -rf scratch",
    "git status | cat",
    "echo $(cat file)",
    "git status > out",
    "cd project && git status",
    "printf '%s' \"$(git status)\"",
    "git status && rm file",
  ].map(async (command) => ({ command, resources: (await ShellApproval.bash(command))?.resources ?? [command] })),
)
const file = new URL("agent_policy.json", import.meta.url)
const content = JSON.stringify({ rules, cases, shells }, null, 2) + "\n"
if (Bun.argv.includes("--check")) {
  if ((await Bun.file(file).text()) !== content)
    throw new Error("Agent permission corpus differs from the TypeScript reference")
} else await Bun.write(file, content)
