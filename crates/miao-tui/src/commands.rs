//! Slash commands: the TUI's own actions and template commands discovered from
//! the same config documents the host reads.
//!
//! A template command is captured, not executed by the TUI: the prompt is
//! rendered here with the argument text and admitted with a `command`
//! reference, so the engine records the command identity and performs its own
//! preparation (`$` mentions, shell substitutions) after promotion.

use std::path::{Path, PathBuf};

/// Config documents, lowest to highest priority inside one directory.
const FILE_NAMES: [&str; 4] = ["miao.json", "miao.jsonc", "opencode.json", "opencode.jsonc"];
/// Directory names a project may use for markdown commands.
const COMMAND_DIRS: [&str; 2] = ["commands", "command"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Builtin {
    Models,
    Permissions,
    Theme,
    Sessions,
    NewSession,
    Rename,
    Status,
    Accounts,
    Debug,
    Stash,
    StashDraft,
    Editor,
    Help,
    Quit,
}

impl Builtin {
    pub const ALL: [Builtin; 14] = [
        Builtin::Models,
        Builtin::Permissions,
        Builtin::Theme,
        Builtin::Sessions,
        Builtin::NewSession,
        Builtin::Rename,
        Builtin::Status,
        Builtin::Accounts,
        Builtin::Debug,
        Builtin::Stash,
        Builtin::StashDraft,
        Builtin::Editor,
        Builtin::Help,
        Builtin::Quit,
    ];

    /// The name without the leading `/`.
    pub fn name(self) -> &'static str {
        match self {
            Builtin::Models => "model",
            Builtin::Permissions => "permissions",
            Builtin::Theme => "theme",
            Builtin::Sessions => "sessions",
            Builtin::NewSession => "new",
            Builtin::Rename => "rename",
            Builtin::Status => "status",
            Builtin::Accounts => "accounts",
            Builtin::Debug => "debug",
            Builtin::Stash => "stash",
            Builtin::StashDraft => "stash-draft",
            Builtin::Editor => "editor",
            Builtin::Help => "help",
            Builtin::Quit => "quit",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Builtin::Models => "Select a model",
            Builtin::Permissions => "Review saved permissions",
            Builtin::Theme => "Select a theme",
            Builtin::Sessions => "Browse sessions",
            Builtin::NewSession => "New session",
            Builtin::Rename => "Rename this session",
            Builtin::Status => "Session status and usage",
            Builtin::Accounts => "Switch account",
            Builtin::Debug => "Engine and workspace details",
            Builtin::Stash => "Restore a stashed prompt",
            Builtin::StashDraft => "Stash the current prompt",
            Builtin::Editor => "Compose the prompt in $EDITOR",
            Builtin::Help => "Keys and commands",
            Builtin::Quit => "Quit miao",
        }
    }

    /// The key chord that runs the same action, empty when it has none.
    pub fn keys(self) -> &'static str {
        match self {
            Builtin::Models => "<leader>m",
            Builtin::Permissions => "",
            Builtin::Theme => "<leader>t",
            Builtin::Sessions => "<leader>l",
            Builtin::NewSession => "<leader>n",
            Builtin::Rename => "ctrl+r",
            Builtin::Status => "<leader>s",
            Builtin::Accounts => "ctrl+o",
            Builtin::Debug => "<leader>d",
            Builtin::Stash => "<leader>p",
            Builtin::StashDraft => "<leader>P",
            Builtin::Editor => "<leader>e",
            Builtin::Help => "",
            Builtin::Quit => "<leader>q",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|builtin| builtin.name() == name)
    }
}

/// One discovered template command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    pub name: String,
    pub description: String,
    pub template: String,
}

/// Names offered by slash completion: every builtin, then discovered templates
/// that do not shadow one.
pub fn completion_names(templates: &[Template]) -> Vec<String> {
    let mut names = Builtin::ALL
        .into_iter()
        .map(|builtin| builtin.name().to_string())
        .collect::<Vec<_>>();
    for template in templates {
        if !names.contains(&template.name) {
            names.push(template.name.clone());
        }
    }
    names
}

/// Load every template command that applies to `workspace`, lowest priority
/// first; a later definition of the same name replaces the earlier one but
/// keeps its original position.
pub fn templates(workspace: &Path) -> Vec<Template> {
    let mut found: Vec<Template> = Vec::new();
    if let Some(directory) = global_config_dir() {
        load_directory(&directory, &mut found);
    }
    if let Some(path) = env_path("MIAO_CONFIG") {
        load_document(&path, &mut found);
    }
    if env_path("MIAO_DISABLE_PROJECT_CONFIG").is_none() {
        let levels = levels(workspace);
        for level in levels.iter().rev() {
            for name in FILE_NAMES {
                load_document(&level.join(name), &mut found);
            }
        }
        for level in levels.iter().rev() {
            load_directory(&level.join(".opencode"), &mut found);
            load_directory(&level.join(".miao"), &mut found);
        }
    }
    if let Some(directory) = env_path("MIAO_CONFIG_DIR") {
        load_directory(&directory, &mut found);
    }
    if let Ok(content) = std::env::var("MIAO_CONFIG_CONTENT") {
        merge_document(&content, &mut found);
    }
    found
}

/// `$XDG_CONFIG_HOME/miao`, falling back to `~/.config/miao`.
fn global_config_dir() -> Option<PathBuf> {
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(config).join("miao"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/miao"))
}

/// `workspace` up to the project root, nearest first, both inclusive. The
/// project root is the closest ancestor holding `.git`.
fn levels(workspace: &Path) -> Vec<PathBuf> {
    let mut levels: Vec<PathBuf> = Vec::new();
    for ancestor in workspace.ancestors() {
        levels.push(ancestor.to_path_buf());
        if ancestor.join(".git").exists() {
            break;
        }
    }
    levels
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn load_document(path: &Path, found: &mut Vec<Template>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    merge_document(&text, found);
}

/// A config document names commands under `commands`; the legacy singular key
/// is still read so a hand-written document keeps working.
fn merge_document(text: &str, found: &mut Vec<Template>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&crate::theme::strip_jsonc(text))
    else {
        return;
    };
    let commands = value
        .get("commands")
        .or_else(|| value.get("command"))
        .and_then(serde_json::Value::as_object);
    let Some(commands) = commands else {
        return;
    };
    for (name, command) in commands {
        let Some(template) = command.get("template").and_then(serde_json::Value::as_str) else {
            continue;
        };
        upsert(
            found,
            Template {
                name: name.clone(),
                description: command
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                template: template.to_string(),
            },
        );
    }
}

/// Read the documents and `{command,commands}/**/*.md` files of one config
/// directory. A missing directory is simply no commands.
fn load_directory(directory: &Path, found: &mut Vec<Template>) {
    for name in FILE_NAMES {
        load_document(&directory.join(name), found);
    }
    // Keep each file's command base: `commands/review.md` is named `review`,
    // and sorting the absolute paths matches the host's glob order.
    let mut files: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in COMMAND_DIRS {
        let base = directory.join(name);
        let mut found_here = Vec::new();
        collect_markdown(&base, &mut found_here);
        files.extend(found_here.into_iter().map(|path| (base.clone(), path)));
    }
    files.sort();
    for (base, path) in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(name) = command_name(&base, &path) else {
            continue;
        };
        let (description, template) = parse_markdown(&text);
        if template.is_empty() {
            continue;
        }
        upsert(
            found,
            Template {
                name,
                description,
                template,
            },
        );
    }
}

fn collect_markdown(directory: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_markdown(&path, files);
            continue;
        }
        if kind.is_file() && path.extension().and_then(|extension| extension.to_str()) == Some("md")
        {
            files.push(path);
        }
    }
}

/// `review.md` in a command directory is `review`; nested directories keep
/// their path.
fn command_name(directory: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(directory).ok()?;
    let mut parts = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let file = parts.pop()?;
    let name = file.strip_suffix(".md")?;
    if name.is_empty() {
        return None;
    }
    parts.push(name.to_string());
    Some(parts.join("/"))
}

/// Frontmatter is a YAML subset here: only `description` is read, and the
/// template is everything after the closing fence.
fn parse_markdown(text: &str) -> (String, String) {
    let trimmed = text.strip_prefix("\u{feff}").unwrap_or(text);
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (String::new(), trimmed.trim().to_string());
    };
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'));
    let Some(rest) = rest else {
        return (String::new(), trimmed.trim().to_string());
    };
    let Some(end) = rest
        .find("\n---")
        .filter(|index| rest[*index + 4..].starts_with('\n') || rest[*index + 4..].is_empty())
    else {
        return (String::new(), trimmed.trim().to_string());
    };
    let frontmatter = &rest[..end];
    let template = rest[end + 4..].trim_start_matches(['\r', '\n']);
    let description = frontmatter
        .lines()
        .find_map(|line| {
            let value = line.strip_prefix("description:")?;
            Some(unquote(value.trim()))
        })
        .unwrap_or_default();
    (description, template.trim().to_string())
}

fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(value)
        .to_string()
}

fn upsert(found: &mut Vec<Template>, template: Template) {
    match found.iter_mut().find(|item| item.name == template.name) {
        Some(item) => *item = template,
        None => found.push(template),
    }
}

/// Render a template the way `SessionCommand.renderTemplate` does: positional
/// `$1`…`$n` (the highest one captures the rest), `$ARGUMENTS` verbatim, and a
/// template with no placeholder appends the arguments as a trailing paragraph.
pub fn render_template(template: &str, arguments: &str) -> String {
    let args = arguments_of(arguments);
    let positions = positions(template);
    let last = positions.iter().copied().max().unwrap_or(0);
    let with_args = replace_positions(template, &args, last);
    let uses_arguments = template.contains("$ARGUMENTS");
    let mut result = with_args.replace("$ARGUMENTS", arguments);
    if positions.is_empty() && !uses_arguments && !arguments.trim().is_empty() {
        result = format!("{result}\n\n{arguments}");
    }
    result.trim().to_string()
}

/// `$1`…`$n` at the current scan position, in order, as the TS matcher finds
/// them. A `$` followed by digits names a placeholder.
fn positions(template: &str) -> Vec<usize> {
    let bytes = template.as_bytes();
    let mut found = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start {
            if let Ok(position) = template[start..end].parse::<usize>() {
                found.push(position);
            }
            index = end;
            continue;
        }
        index += 1;
    }
    found
}

fn replace_positions(template: &str, args: &[String], last: usize) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            let next = template[index..].chars().next().expect("char at index");
            out.push(next);
            index += next.len_utf8();
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            out.push('$');
            index += 1;
            continue;
        }
        let position = template[start..end].parse::<usize>().unwrap_or_default();
        out.push_str(&position_value(position, args, last));
        index = end;
    }
    out
}

fn position_value(position: usize, args: &[String], last: usize) -> String {
    if position == 0 {
        return String::new();
    }
    let index = position - 1;
    if index >= args.len() {
        return String::new();
    }
    if position == last {
        return args[index..].join(" ");
    }
    args[index].clone()
}

/// Tokenize argument text like the TS matcher: `[Image N]` blocks stay whole,
/// quoted runs lose their quotes, and everything else ends at whitespace or a
/// quote character.
pub fn arguments_of(arguments: &str) -> Vec<String> {
    let chars = arguments.char_indices().collect::<Vec<_>>();
    let mut args = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let (offset, c) = chars[index];
        if c.is_whitespace() {
            index += 1;
            continue;
        }
        if let Some(token) = image_token(arguments, offset) {
            args.push(token.0);
            index = token.1;
            continue;
        }
        if c == '"' || c == '\'' {
            let start = offset + c.len_utf8();
            let rest = &arguments[start..];
            let (value, consumed) = match rest.find(c) {
                Some(end) => (rest[..end].to_string(), start + end + c.len_utf8()),
                None => (rest.to_string(), arguments.len()),
            };
            args.push(value);
            index = chars
                .iter()
                .position(|(position, _)| *position >= consumed)
                .unwrap_or(chars.len());
            continue;
        }
        let mut end = offset;
        for (position, character) in &chars[index..] {
            if character.is_whitespace() || *character == '"' || *character == '\'' {
                break;
            }
            end = *position + character.len_utf8();
        }
        args.push(trim_quotes(&arguments[offset..end]));
        index = chars
            .iter()
            .position(|(position, _)| *position >= end)
            .unwrap_or(chars.len());
    }
    args
}

/// `[Image 1]` at `offset`, and the index just past it.
fn image_token(text: &str, offset: usize) -> Option<(String, usize)> {
    let inner = text[offset..].strip_prefix('[')?;
    let word_end = inner
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(inner.len());
    if word_end == 0 || !inner[..word_end].eq_ignore_ascii_case("image") {
        return None;
    }
    let mut index = word_end;
    let spaces_start = index;
    while let Some(c) = inner[index..].chars().next().filter(|c| c.is_whitespace()) {
        index += c.len_utf8();
    }
    if index == spaces_start {
        return None;
    }
    let digits_start = index;
    while inner[index..]
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit())
    {
        index += 1;
    }
    if index == digits_start || !inner[index..].starts_with(']') {
        return None;
    }
    let end = offset + 1 + index + 1;
    Some((text[offset..end].to_string(), end))
}

fn trim_quotes(token: &str) -> String {
    let head = token
        .strip_prefix('"')
        .or_else(|| token.strip_prefix('\''))
        .unwrap_or(token);
    head.strip_suffix('"')
        .or_else(|| head.strip_suffix('\''))
        .unwrap_or(head)
        .to_string()
}

/// Split a submitted prompt into its command name and argument text, matching
/// the TS prompt: the first space-delimited token of the first line names the
/// command, everything after it (later lines included) is the argument text.
pub fn split(text: &str) -> Option<(String, String)> {
    let (first_line, rest) = match text.find('\n') {
        Some(index) => (&text[..index], &text[index + 1..]),
        None => (text, ""),
    };
    let (command, arguments) = match first_line.split_once(' ') {
        Some((command, arguments)) => (command, arguments),
        None => (first_line, ""),
    };
    let name = command.strip_prefix('/')?;
    if name.is_empty() {
        return None;
    }
    let arguments = if rest.is_empty() {
        arguments.to_string()
    } else {
        format!("{arguments}\n{rest}")
    };
    Some((name.to_string(), arguments))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("miao-tui-commands-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn the_highest_positional_placeholder_captures_the_rest() {
        assert_eq!(
            render_template("Compare $1 with $2", "a b c"),
            "Compare a with b c"
        );
        assert_eq!(render_template("Only $1", "a b"), "Only a b");
        // The rendered prompt is trimmed, so a missing positional leaves no
        // trailing space.
        assert_eq!(render_template("Missing $2", "a"), "Missing");
    }

    #[test]
    fn quoted_arguments_lose_their_quotes() {
        assert_eq!(
            arguments_of("one \"two three\" 'four five' six"),
            vec!["one", "two three", "four five", "six"]
        );
        assert_eq!(
            render_template("$1|$2|$3", "one \"two three\" 'four five'"),
            "one|two three|four five"
        );
    }

    #[test]
    fn image_blocks_stay_single_arguments() {
        assert_eq!(
            arguments_of("[Image 1] look"),
            vec!["[Image 1]".to_string(), "look".to_string()]
        );
    }

    #[test]
    fn a_template_without_placeholders_appends_the_raw_arguments() {
        assert_eq!(
            render_template("Review this", "src/a.rs"),
            "Review this\n\nsrc/a.rs"
        );
        assert_eq!(render_template("Review this", "  "), "Review this");
        assert_eq!(
            render_template("Raw: $ARGUMENTS", "  two  words "),
            "Raw:   two  words"
        );
    }

    #[test]
    fn multiline_arguments_are_tokenized_like_whitespace() {
        assert_eq!(render_template("$1", "first\nsecond"), "first second");
        assert_eq!(
            render_template("$1", "first\nsecond\nthird"),
            "first second third"
        );
    }

    #[test]
    fn split_reads_the_first_token_of_the_first_line_only() {
        assert_eq!(
            split("/review src/a.rs\nmore text"),
            Some(("review".into(), "src/a.rs\nmore text".into()))
        );
        assert_eq!(split("/status"), Some(("status".into(), String::new())));
        assert_eq!(split("hello /status"), None);
        assert_eq!(split("/"), None);
        assert_eq!(
            split("/new  two spaces"),
            Some(("new".into(), " two spaces".into()))
        );
    }

    #[test]
    fn a_config_document_names_commands_and_the_nearest_directory_wins() {
        let dir = temp_dir("docs");
        std::fs::write(
            dir.join("miao.json"),
            r#"{
              // comments and trailing commas are JSONC
              "commands": {
                "review": {"template": "Review $1", "description": "Read a diff"},
                "empty": {"description": "no template"}
              },
            }"#,
        )
        .expect("write config");
        let commands = dir.join("commands");
        std::fs::create_dir_all(commands.join("nested")).expect("commands dir");
        std::fs::write(
            commands.join("review.md"),
            "---\ndescription: Markdown review\n---\nReview the workspace\n",
        )
        .expect("write markdown");
        std::fs::write(commands.join("nested").join("ship.md"), "Ship it").expect("nested");

        let mut found = Vec::new();
        load_directory(&dir, &mut found);
        let names = found
            .iter()
            .map(|template| template.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["review", "nested/ship"]);
        assert_eq!(found[0].template, "Review the workspace");
        assert_eq!(found[0].description, "Markdown review");
        assert_eq!(found[1].template, "Ship it");
    }

    #[test]
    fn project_commands_live_under_the_miao_directory() {
        let dir = temp_dir("project");
        let commands = dir.join(".miao").join("commands");
        std::fs::create_dir_all(&commands).expect("command dir");
        std::fs::write(commands.join("ship.md"), "Ship $1").expect("write markdown");
        let mut found = Vec::new();
        load_directory(&dir.join(".miao"), &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "ship");
        assert_eq!(found[0].template, "Ship $1");
    }

    #[test]
    fn the_closest_configuration_file_wins() {
        let dir = temp_dir("override");
        std::fs::write(
            dir.join("miao.json"),
            r#"{"commands": {"a": {"template": "first"}}}"#,
        )
        .expect("write json");
        std::fs::write(
            dir.join("opencode.json"),
            r#"{"commands": {"a": {"template": "second"}, "b": {"template": "new"}}}"#,
        )
        .expect("write opencode");
        let mut found = Vec::new();
        load_directory(&dir, &mut found);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "a");
        assert_eq!(found[0].template, "second");
        assert_eq!(found[1].name, "b");
    }

    #[test]
    fn builtin_names_round_trip() {
        for builtin in Builtin::ALL {
            assert_eq!(Builtin::from_name(builtin.name()), Some(builtin));
        }
        assert_eq!(Builtin::from_name("nope"), None);
    }
}
