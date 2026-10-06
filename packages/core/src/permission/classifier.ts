/**
 * Deterministic safety classifier for the permission `auto` mode: asks the
 * rules would raise are approved without a prompt only when every affected
 * operation is known-safe. Anything the classifier cannot prove safe —
 * including parse failures — stays a normal ask, and deny rules are never
 * consulted here.
 */
export * as PermissionClassifier from "./classifier"

import path from "path"
import { extract } from "../shell/extract"
import { ShellParser } from "../shell/parser"

export type Verdict = "safe" | "unknown"

/** Directory names whose contents are never touched without a real ask. */
const PROTECTED_SEGMENTS = new Set([".git", ".miao", ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".password-store"])

/** File names that hold credentials or shell startup code. */
const PROTECTED_NAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  ".bashrc",
  ".zshrc",
  ".profile",
  ".bash_profile",
  ".gitconfig",
  ".gitcredentials",
  ".netrc",
  ".npmrc",
  ".wgetrc",
  ".curlrc",
  ".htpasswd",
  ".kubeconfig",
])

/** Suffixes of files that hold secrets. `.env*` names are covered by name check. */
const PROTECTED_SUFFIXES = [".pem", ".key", ".p12", ".pfx"]

/**
 * Commands whose every argument is inspected and every effect is output to
 * stdout. Commands that can write files through flags (`sort -o`, `sed -i`,
 * `find -delete`), execute arguments (`xargs`, `awk`), or dump secrets
 * (`printenv`, `env`) are excluded so the list needs no flag analysis.
 */
const READONLY = new Set([
  "ls",
  "pwd",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "fd",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "which",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "diff",
  "cmp",
  "comm",
  "cut",
  "uniq",
  "jq",
  "date",
  "whoami",
  "id",
  "hostname",
  "uname",
  "sleep",
])

/** `git` subcommands that only read the repository. */
const GIT_READONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "grep",
  "help",
])

export const edit = (resources: readonly string[], worktree: string): Verdict =>
  resources.length > 0 && resources.every((resource) => inside(resource, worktree) && !protectedPath(resource))
    ? "safe"
    : "unknown"

export const bash = async (commands: readonly string[]): Promise<Verdict> => {
  if (process.platform === "win32" || commands.length === 0) return "unknown"
  for (const command of commands) {
    if ((await classifyCommand(command)) === "unknown") return "unknown"
  }
  return "safe"
}

async function classifyCommand(command: string): Promise<Verdict> {
  const parser = await ShellParser.bash()
  const tree = parser.parse(command)
  if (!tree) return "unknown"
  if (tree.rootNode.hasError) {
    tree.delete()
    return "unknown"
  }
  // A redirection anywhere — including inside substitutions and heredocs —
  // can write outside the model's view, so the whole command stays an ask.
  if (tree.rootNode.descendantsOfType(["file_redirect", "heredoc_redirect", "herestring_redirect"]).length > 0) {
    tree.delete()
    return "unknown"
  }
  const extracted = extract(tree.rootNode).filter((item) => item.tokens.length > 0)
  tree.delete()
  if (extracted.length === 0) return "unknown"
  return extracted.every((item) => safeTokens(item.tokens)) ? "safe" : "unknown"
}

function safeTokens(tokens: readonly string[]): boolean {
  const head = tokens[0]
  if (head === "git") return gitSafe(tokens.slice(1))
  if (head === "sudo" || head === "doas") return false
  if (!READONLY.has(head)) return false
  return tokens.every(tokenSafe)
}

function gitSafe(args: readonly string[]): boolean {
  const sub = args[0]
  if (sub === undefined) return true
  // `git branch <name>` creates a ref, so bare listing only.
  if (sub === "branch") return args.length === 1
  return GIT_READONLY.has(sub) && args.every(tokenSafe)
}

function tokenSafe(token: string): boolean {
  return token
    .replace(/^-+/, "")
    .split("=")
    .every((part) => !protectedPath(part))
}

function inside(resource: string, worktree: string): boolean {
  const relative = path.relative(worktree, resource)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function protectedPath(resource: string): boolean {
  const base = path.basename(resource)
  if (PROTECTED_NAMES.has(base) || base.startsWith(".env")) return true
  if (PROTECTED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true
  return resource.split(path.sep).some((segment) => PROTECTED_SEGMENTS.has(segment))
}
