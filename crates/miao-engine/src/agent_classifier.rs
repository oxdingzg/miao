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

/// Host resources retain their original spelling for rule matching. Resolve
/// them lexically against the captured host cwd only for classification.
/// Filesystem capability and symlink checks still belong to the executor.
pub fn host_edit(resources: &[String], host: &crate::product::HostContext) -> Verdict {
    use std::path::{Component, Path, PathBuf};
    fn normalize(path: &Path) -> PathBuf {
        path.components()
            .fold(PathBuf::new(), |mut result, component| {
                match component {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        result.pop();
                    }
                    _ => result.push(component.as_os_str()),
                }
                result
            })
    }
    if resources.is_empty() {
        return Verdict::Unknown;
    }
    let directory = normalize(Path::new(&host.directory));
    let safe = resources.iter().all(|resource| {
        if protected_path(resource) {
            return false;
        }
        let path = Path::new(resource);
        let target = if path.is_absolute() {
            normalize(path)
        } else {
            let Some(cwd) = &host.cwd else {
                return false;
            };
            normalize(&Path::new(cwd).join(path))
        };
        let Ok(relative) = target.strip_prefix(&directory) else {
            return false;
        };
        // Match the product's lexical containment check, including its refusal
        // of a root itself and names beginning with two dots.
        !relative.as_os_str().is_empty()
            && !relative.to_string_lossy().starts_with("..")
            && !protected_path(&target.to_string_lossy())
    });
    if safe {
        return Verdict::Safe;
    }
    Verdict::Unknown
}

pub fn bash(command: &str) -> Verdict {
    let Some(tree) = parse(command) else {
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

/// The same verdict for an argv command.
///
/// `run_command` hands its array straight to the runner, so no shell reads it:
/// the head and every token are exactly the words that will be executed, and
/// they are checked the way a parsed single command would be. Shell syntax
/// cannot appear here, which is why `argv` never needs a parser.
pub fn argv(argv: &[String]) -> Verdict {
    let tokens = argv.iter().map(String::as_str).collect::<Vec<_>>();
    if safe_tokens(&tokens) {
        Verdict::Safe
    } else {
        Verdict::Unknown
    }
}

/// Every command in a shell line, tokenized as [`bash`] classifies it. Callers
/// that read the action out of the words rather than judging its safety — branch
/// discipline, for one — share this extraction instead of parsing twice.
pub(crate) fn words(command: &str) -> Option<Vec<Vec<String>>> {
    let tree = parse(command)?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    let extracted: Vec<Vec<String>> = commands(root, command)
        .into_iter()
        .filter(|tokens| !tokens.is_empty())
        .map(|tokens| tokens.into_iter().map(str::to_owned).collect())
        .collect();
    if extracted.is_empty() {
        None
    } else {
        Some(extracted)
    }
}

fn parse(command: &str) -> Option<tree_sitter::Tree> {
    // The engine runs every command through `bash -c` on every platform,
    // Windows included (`process::Input::argv`), so bash syntax is exactly what
    // Windows executes too and the same parse is the right analysis there. The
    // length bound only turns a pathological parse into an ask instead of a
    // stall.
    if command.is_empty() || command.len() > 65536 {
        return None;
    }
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .ok()?;
    parser.parse(command, None)
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
        assert_eq!(bash("cat .env"), Verdict::Unknown);
        assert_eq!(bash("cat .env.local"), Verdict::Unknown);
        assert_eq!(bash("grep pattern .ssh/config"), Verdict::Unknown);
        assert_eq!(bash("cat server.pem"), Verdict::Unknown);
        assert_eq!(bash("head --lines=5 ~/.gitconfig"), Verdict::Unknown);
        assert_eq!(bash("ls .git"), Verdict::Unknown);
        assert_eq!(bash("cat src/app.ts"), Verdict::Safe);
    }

    #[test]
    fn an_argv_command_is_judged_by_the_words_it_will_execute() {
        // `run_command` never reaches a shell, so its array is the whole
        // command: the same head/token proof applies without a parser.
        let words = |argv: &[&str]| argv.iter().map(|word| word.to_string()).collect::<Vec<_>>();
        assert_eq!(argv(&words(&["ls", "-la"])), Verdict::Safe);
        assert_eq!(argv(&words(&["grep", "pattern", "src/"])), Verdict::Safe);
        assert_eq!(argv(&words(&["git", "status"])), Verdict::Safe);
        assert_eq!(argv(&words(&["rm", "-rf", "scratch"])), Verdict::Unknown);
        assert_eq!(argv(&words(&["sh", "-c", "rm -rf /"])), Verdict::Unknown);
        assert_eq!(argv(&words(&["cat", ".env"])), Verdict::Unknown);
        assert_eq!(argv(&words(&["sudo", "ls"])), Verdict::Unknown);
        assert_eq!(argv(&words(&[])), Verdict::Unknown);
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
