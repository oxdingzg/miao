import { PermissionV2 } from "../../../../packages/core/src/permission"
import { PermissionClassifier } from "../../../../packages/core/src/permission/classifier"

// Golden decisions come from the real layered TypeScript evaluator (S6 step 1).
// Rust consumes this corpus to pin the rule semantics at the bridge: same
// input, same conclusion, including the exact ruleset each outcome reports.
const rule = (action: string, resource: string, effect: PermissionV2.Effect) => ({
  action,
  resource,
  effect,
})

const ruleCases = [
  { name: "explicit-without-an-agent-ruleset-still-filters-the-catch-all", request: {
    actions: ["sandbox-escape"], resources: ["host"], explicit: true,
  } },
  { name: "two-question-marks-deny-one-supplementary-character", request: {
    actions: ["read"], resources: ["😀.txt"],
    configured: [rule("read", "*", "allow"), rule("read", "??.txt", "deny")],
  } },
  { name: "one-question-mark-does-not-deny-a-surrogate-pair", request: {
    actions: ["read"], resources: ["😀.txt"],
    configured: [rule("read", "*", "allow"), rule("read", "?.txt", "deny")],
  } },
  { name: "two-question-marks-do-not-grant-one-bmp-character", request: {
    actions: ["read"], resources: ["中.txt"],
    configured: [rule("read", "??.txt", "allow")],
  } },
  { name: "star-can-consume-part-of-a-surrogate-pair-before-a-question", request: {
    actions: ["read"], resources: ["😀.txt"],
    configured: [rule("read", "*", "allow"), rule("read", "*?.txt", "deny")],
  } },
  { name: "literal-supplementary-characters-remain-exact", request: {
    actions: ["read"], resources: ["😀.txt"],
    configured: [rule("read", "😀.txt", "allow")],
  } },
  { name: "action-questions-also-count-utf16-units", request: {
    actions: ["custom😀"], resources: ["a.txt"],
    configured: [rule("*", "*", "allow"), rule("custom??", "*", "deny")],
  } },
  { name: "optional-command-arguments-preserve-utf16-matching", request: {
    actions: ["bash"], resources: ["echo 😀"],
    configured: [rule("bash", "echo ?? *", "deny")],
  } },
  { name: "last-rule-wins-so-a-later-scope-shadows-an-earlier-one", request: {
    actions: ["bash"],
    resources: ["rm -rf x"],
    configured: [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")],
  } },
  { name: "priority-inverts-with-rule-order", request: {
    actions: ["bash"],
    resources: ["rm -rf x"],
    configured: [rule("bash", "rm *", "deny"), rule("bash", "*", "allow")],
  } },
  { name: "project-scope-shadows-global", request: {
    actions: ["edit"],
    resources: ["secrets/key.env"],
    configured: [rule("edit", "*", "allow"), rule("edit", "secrets/*", "ask")],
  } },
  { name: "configured-deny-beats-a-later-saved-allow", request: {
    actions: ["bash"],
    resources: ["git push origin"],
    configured: [rule("bash", "git push *", "deny")],
    saved: [rule("bash", "git *", "allow")],
  } },
  { name: "saved-allow-lifts-a-configured-ask", request: {
    actions: ["bash"],
    resources: ["git status"],
    configured: [rule("bash", "git status *", "ask")],
    saved: [rule("bash", "git status *", "allow")],
  } },
  { name: "no-matching-rule-asks", request: {
    actions: ["read"],
    resources: ["a.ts"],
    configured: [],
  } },
  { name: "no-configured-rules-with-a-saved-allow-allows", request: {
    actions: ["read"],
    resources: ["a.ts"],
    configured: [],
    saved: [rule("read", "*", "allow")],
  } },
  { name: "agent-without-a-ruleset-denies-everything-saved-included", request: {
    actions: ["read"],
    resources: ["a.ts"],
    saved: [rule("read", "*", "allow")],
  } },
  { name: "star-crosses-directories", request: {
    actions: ["read"],
    resources: ["nested/secret.env"],
    configured: [rule("read", "*", "allow"), rule("read", "*.env", "ask")],
  } },
  { name: "question-mark-consumes-exactly-one-character", request: {
    actions: ["read"],
    resources: ["file1.txt"],
    configured: [rule("read", "*", "allow"), rule("read", "file?.txt", "ask")],
  } },
  { name: "question-mark-does-not-consume-two-characters", request: {
    actions: ["read"],
    resources: ["file12.txt"],
    configured: [rule("read", "*", "allow"), rule("read", "file?.txt", "ask")],
  } },
  { name: "trailing-star-makes-arguments-optional", request: {
    actions: ["bash"],
    resources: ["git status"],
    configured: [rule("bash", "git status *", "allow")],
  } },
  { name: "trailing-star-matches-arguments", request: {
    actions: ["bash"],
    resources: ["git status --short"],
    configured: [rule("bash", "git status *", "allow")],
  } },
  { name: "trailing-star-does-not-extend-the-prefix", request: {
    actions: ["bash"],
    resources: ["git status-other"],
    configured: [rule("bash", "git status *", "allow")],
  } },
  { name: "brackets-are-literal-not-a-character-class", request: {
    actions: ["read"],
    resources: ["literal[1].txt"],
    configured: [rule("read", "literal[1].txt", "allow")],
  } },
  { name: "escaped-syntax-does-not-wildcard", request: {
    actions: ["read"],
    resources: ["literal1.txt"],
    configured: [rule("read", "literal[1].txt", "allow")],
  } },
  { name: "backslash-normalizes-to-slash", request: {
    actions: ["read"],
    resources: ["nested\\secret.env"],
    configured: [rule("read", "*", "allow"), rule("read", "*.env", "ask")],
  } },
  { name: "multi-resource-takes-the-worst-effect", request: {
    actions: ["read"],
    resources: ["a.ts", "secret.env"],
    configured: [rule("read", "*", "allow"), rule("read", "*.env", "ask")],
  } },
  { name: "every-resource-allowing-allows", request: {
    actions: ["read"],
    resources: ["a.ts", "b.ts"],
    configured: [rule("read", "*", "allow")],
  } },
  { name: "a-deny-on-any-resource-deny-despite-other-allows", request: {
    actions: ["read"],
    resources: ["a.ts", ".env"],
    configured: [rule("read", "*", "allow"), rule("read", ".env", "deny")],
    saved: [rule("read", "*", "allow")],
  } },
  { name: "explicit-skips-bare-wildcard-action-rules", request: {
    actions: ["sandbox-escape"],
    resources: ["host"],
    configured: [rule("*", "*", "allow")],
    explicit: true,
  } },
  { name: "explicit-keeps-rules-naming-the-action", request: {
    actions: ["read"],
    resources: ["a.ts"],
    configured: [rule("read", "*", "allow"), rule("*", "*", "deny")],
    explicit: true,
  } },
  { name: "explicit-filters-the-deny-all-too", request: {
    actions: ["sandbox-escape"],
    resources: ["host"],
    configured: [rule("*", "*", "deny")],
    explicit: true,
  } },
  { name: "aliases-decide-like-the-action-they-name", request: {
    actions: ["bash", "terminal"],
    resources: ["git status"],
    configured: [rule("terminal", "git status *", "allow")],
  } },
  { name: "a-saved-deny-can-decide-in-the-merged-sweep", request: {
    actions: ["read"],
    resources: ["secret.env"],
    configured: [rule("read", "*", "allow")],
    saved: [rule("read", "secret.env", "deny")],
  } },
  { name: "empty-resources-allows-vacuously-as-pinned", request: {
    actions: ["read"],
    resources: [],
    configured: [],
  } },
  { name: "empty-actions-never-match-so-they-ask", request: {
    actions: [],
    resources: ["a.ts"],
    configured: [rule("read", "*", "allow")],
  } },
  { name: "action-wildcards-match-derived-actions", request: {
    actions: ["read_file"],
    resources: ["a.ts"],
    configured: [rule("read*", "*", "allow")],
  } },
  { name: "action-wildcards-do-not-match-unrelated-actions", request: {
    actions: ["write"],
    resources: ["a.ts"],
    configured: [rule("read*", "*", "allow")],
  } },
  { name: "an-alias-hits-a-deny-aimed-at-the-alias", request: {
    actions: ["bash", "terminal"],
    resources: ["rm -rf x"],
    configured: [rule("terminal", "rm *", "deny")],
  } },
  { name: "saved-rules-for-other-actions-do-not-hide-an-ask", request: {
    actions: ["edit"],
    resources: ["a.ts"],
    configured: [rule("read", "*", "allow")],
    saved: [rule("bash", "*", "allow")],
  } },
  { name: "an-action-wildcard-catch-all-still-decides-non-explicit", request: {
    actions: ["read"],
    resources: ["a.ts"],
    configured: [rule("read*", "*", "allow"), rule("*", "*.env", "ask")],
  } },
]

// A case that names a mode pins what the product does with it: `decide` answers
// the rules layer alone, and `auto` settles an ask the classifier can prove
// safe. The engine keeps the distinction in `permission.rs::auto_settles`, so
// the corpus has to state the settled effect rather than the raw ask.
const autoCases = [
  { name: "auto-mode-settles-a-safe-ask", mode: "auto", request: {
    actions: ["bash"], resources: ["git status"],
    configured: [rule("bash", "*", "ask")],
  } },
  { name: "auto-mode-keeps-an-ask-the-classifier-cannot-prove-safe", mode: "auto", request: {
    actions: ["bash"], resources: ["git push"],
    configured: [rule("bash", "*", "ask")],
  } },
  { name: "auto-mode-never-settles-a-deny", mode: "auto", request: {
    actions: ["bash"], resources: ["git status"],
    configured: [rule("bash", "*", "deny")],
  } },
]

const cases = [
  ...ruleCases.map((item) => ({ ...item, expected: PermissionV2.decide(item.request) })),
  ...(await Promise.all(
    autoCases.map(async (item) => {
      const decided = PermissionV2.decide(item.request)
      if (decided.effect !== "ask") return { ...item, expected: decided }
      const verdict = await PermissionClassifier.bash(item.request.resources)
      return { ...item, expected: verdict === "safe" ? { effect: "allow" as const, rules: decided.rules } : decided }
    }),
  )),
]

const file = new URL("permission_decide.json", import.meta.url)
const content =
  JSON.stringify({ semantics: "configured-deny-first-then-last-match-v1", cases }, null, 2) + "\n"
if (Bun.argv.includes("--check")) {
  if ((await Bun.file(file).text()) !== content)
    throw new Error("Permission decide corpus differs from the TypeScript reference")
  console.log("permission_decide.json matches the TypeScript reference")
} else await Bun.write(file, content)
