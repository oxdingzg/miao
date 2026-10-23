//! Deterministic safety classifier for the permission `auto` mode, ported from
//! the product's `permission/classifier.ts`. Asks the rules would raise are
//! approved without a prompt only when every affected operation is known-safe.
//! Anything the classifier cannot prove safe — including parse failures —
//! stays a normal ask, and deny rules are never consulted here.

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Safe,
    Unknown,
}

/// Directory names whose contents are never touched without a real ask.
const PROTECTED_SEGMENTS: [&str; 8] = [
    ".git",
    ".miao",
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".password-store",
];

/// File names that hold credentials or shell startup code.
const PROTECTED_NAMES: [&str; 15] = [
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
];

/// Suffixes of files that hold secrets. `.env*` names are covered by name check.
const PROTECTED_SUFFIXES: [&str; 4] = [".pem", ".key", ".p12", ".pfx"];

/// Commands whose every argument is inspected and every effect is output to
/// stdout. Commands that can write files through flags (`sort -o`, `sed -i`,
/// `find -delete`), execute arguments (`xargs`, `awk`), or dump secrets
/// (`printenv`, `env`) are excluded so the list needs no flag analysis.
const READONLY: [&str; 34] = [
    "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "grep", "rg", "fd", "file", "stat",
    "du", "df", "tree", "which", "type", "basename", "dirname", "realpath", "readlink", "diff",
    "cmp", "comm", "cut", "uniq", "jq", "date", "whoami", "id", "hostname", "uname", "sleep",
];

/// `git` subcommands that only read the repository.
const GIT_READONLY: [&str; 12] = [
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
];

const KEPT_TOKENS: [&str; 6] = [
    "command_name",
    "command_name_expr",
    "word",
    "string",
    "raw_string",
    "concatenation",
];

const REDIRECTS: [&str; 3] = ["file_redirect", "heredoc_redirect", "herestring_redirect"];

/// Workspace edits are safe when every target is a normal workspace path.
/// Containment itself is enforced upstream by the policy boundary check, so
/// unlike the host classifier this does not re-derive `path.relative`; an
/// absolute or escaping target still refuses, as it can only appear here by
/// bypassing that check.
pub fn edit(targets: &[String]) -> Verdict {
    if targets.is_empty() {
        return Verdict::Unknown;
    }
    let ok = targets.iter().all(|target| {
        let normalized = target.replace('\\', "/");
        !normalized.is_empty()
            && !normalized.starts_with('/')
            && !normalized.split('/').any(|part| part == "..")
            && !protected_path(target)
    });
    if ok {
        Verdict::Safe
    } else {
        Verdict::Unknown
    }
}

pub fn bash(command: &str) -> Verdict {
    // The host classifier declines on Windows; the extra length bound only
    // turns a pathological parse into an ask instead of a stall.
    if cfg!(windows) || command.is_empty() || command.len() > 65536 {
        return Verdict::Unknown;
    }
    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .is_err()
    {
        return Verdict::Unknown;
    }
    let Some(tree) = parser.parse(command, None) else {
        return Verdict::Unknown;
    };
    let root = tree.root_node();
    // A redirection anywhere — including inside substitutions and heredocs —
    // can write outside the model's view, so the whole command stays an ask.
    if root.has_error() || has_descendant(root, &REDIRECTS) {
        return Verdict::Unknown;
    }
    let extracted: Vec<Vec<&str>> = commands(root, command)
        .into_iter()
        .filter(|tokens| !tokens.is_empty())
        .collect();
    if extracted.is_empty() {
        return Verdict::Unknown;
    }
    if extracted.iter().all(|tokens| safe_tokens(tokens)) {
        Verdict::Safe
    } else {
        Verdict::Unknown
    }
}

fn has_descendant(root: Node<'_>, kinds: &[&str]) -> bool {
    let mut nodes = vec![root];
    while let Some(node) = nodes.pop() {
        if kinds.contains(&node.kind()) {
            return true;
        }
        let mut cursor = node.walk();
        nodes.extend(node.children(&mut cursor));
    }
    false
}

/// Every command in the tree, in document order, as the token texts the host
/// `shell/extract.ts` derives from `command` and `command_elements` nodes.
fn commands<'a>(root: Node<'a>, command: &'a str) -> Vec<Vec<&'a str>> {
    let mut nodes = vec![root];
    let mut extracted = Vec::new();
    while let Some(node) = nodes.pop() {
        if node.kind() == "command" {
            extracted.push(tokens(node, command));
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        nodes.extend(children.into_iter().rev());
    }
    extracted
}

fn tokens<'a>(node: Node<'a>, command: &'a str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "command_elements" {
            let mut inner = child.walk();
            for item in child.children(&mut inner) {
                if item.kind() == "command_argument_sep" || item.kind() == "redirection" {
                    continue;
                }
                out.push(text(item, command));
            }
            continue;
        }
        if KEPT_TOKENS.contains(&child.kind()) {
            out.push(text(child, command));
        }
    }
    out
}

fn text<'a>(node: Node, command: &'a str) -> &'a str {
    node.utf8_text(command.as_bytes()).unwrap_or("")
}

fn safe_tokens(tokens: &[&str]) -> bool {
    let Some(head) = tokens.first() else {
        return false;
    };
    if *head == "git" {
        return git_safe(&tokens[1..]);
    }
    if *head == "sudo" || *head == "doas" {
        return false;
    }
    if !READONLY.contains(head) {
        return false;
    }
    tokens.iter().all(|token| token_safe(token))
}

fn git_safe(args: &[&str]) -> bool {
    let Some(sub) = args.first() else {
        return true;
    };
    // `git branch <name>` creates a ref, so bare listing only.
    if *sub == "branch" {
        return args.len() == 1;
    }
    GIT_READONLY.contains(sub) && args.iter().all(|token| token_safe(token))
}

fn token_safe(token: &str) -> bool {
    token
        .trim_start_matches('-')
        .split('=')
        .all(|part| !protected_path(part))
}

fn protected_path(resource: &str) -> bool {
    let normalized = resource.replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or("");
    if PROTECTED_NAMES.contains(&base) || base.starts_with(".env") {
        return true;
    }
    if PROTECTED_SUFFIXES
        .iter()
        .any(|suffix| base.ends_with(suffix))
    {
        return true;
    }
    normalized
        .split('/')
        .any(|segment| PROTECTED_SEGMENTS.contains(&segment))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_bash_is_safe_and_mutating_or_opaque_bash_stays_unknown() {
        if cfg!(windows) {
            // The host classifier also declines on Windows: cmd/bat semantics
            // make token-level readonly checks unreliable, so every bash ask
            // stays a prompt there.
            assert_eq!(bash("ls -la"), Verdict::Unknown);
            assert_eq!(bash("rm -rf scratch"), Verdict::Unknown);
            return;
        }
        assert_eq!(bash("ls -la"), Verdict::Safe);
        assert_eq!(bash("git status; git log --oneline"), Verdict::Safe);
        assert_eq!(bash("echo hello world"), Verdict::Safe);
        assert_eq!(bash("rg pattern src/"), Verdict::Safe);
        // No flag analysis: every argument of a listed command is only checked
        // for protected paths, exactly like the host.
        assert_eq!(bash("cat --output=x in"), Verdict::Safe);
        assert_eq!(bash("rm -rf scratch"), Verdict::Unknown);
        assert_eq!(bash("sudo ls"), Verdict::Unknown);
        assert_eq!(bash("xargs rm < list"), Verdict::Unknown);
        assert_eq!(bash("echo hi > out.txt"), Verdict::Unknown);
        assert_eq!(bash("cat <<EOF\nhi\nEOF"), Verdict::Unknown);
        assert_eq!(bash("git branch work"), Verdict::Unknown);
        assert_eq!(bash("git branch"), Verdict::Safe);
        assert_eq!(bash("git push"), Verdict::Unknown);
        assert_eq!(bash("printenv"), Verdict::Unknown);
        assert_eq!(bash("totally-unknown-cmd"), Verdict::Unknown);
        assert_eq!(bash("true"), Verdict::Unknown);
        assert_eq!(bash("ls )"), Verdict::Unknown);
    }

    #[test]
    fn protected_paths_are_never_classified_safe() {
        if cfg!(windows) {
            // Bash declines wholesale on Windows (see the readonly test), so
            // no path distinction is observable through it there.
            assert_eq!(bash("cat .env"), Verdict::Unknown);
            assert_eq!(bash("cat src/app.ts"), Verdict::Unknown);
            return;
        }
        assert_eq!(bash("cat .env"), Verdict::Unknown);
        assert_eq!(bash("cat .env.local"), Verdict::Unknown);
        assert_eq!(bash("grep pattern .ssh/config"), Verdict::Unknown);
        assert_eq!(bash("cat server.pem"), Verdict::Unknown);
        assert_eq!(bash("head --lines=5 ~/.gitconfig"), Verdict::Unknown);
        assert_eq!(bash("ls .git"), Verdict::Unknown);
        assert_eq!(bash("cat src/app.ts"), Verdict::Safe);
    }

    #[test]
    fn edit_targets_must_be_plain_workspace_paths() {
        assert_eq!(
            edit(&["src/app.ts".into(), "docs/b.md".into()]),
            Verdict::Safe
        );
        assert_eq!(edit(&[".env".into()]), Verdict::Unknown);
        assert_eq!(edit(&["keys/server.key".into()]), Verdict::Unknown);
        assert_eq!(edit(&[".miao/store/x".into()]), Verdict::Unknown);
        assert_eq!(edit(&["../outside".into()]), Verdict::Unknown);
        assert_eq!(edit(&["/etc/passwd".into()]), Verdict::Unknown);
        assert_eq!(edit(&[]), Verdict::Unknown);
    }
}
