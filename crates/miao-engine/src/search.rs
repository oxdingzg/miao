use crate::{
    permission::{Access, Decision, Policy},
    tools::ToolError,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use globset::{GlobBuilder, GlobMatcher};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobInput {
    pattern: String,
    #[serde(default = "base")]
    path: String,
    #[serde(default = "limit")]
    limit: usize,
    #[serde(default)]
    include_hidden: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrepInput {
    pattern: String,
    #[serde(default = "base")]
    path: String,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default = "limit")]
    limit: usize,
    #[serde(default = "yes")]
    case_sensitive: bool,
    #[serde(default)]
    include_hidden: bool,
}
fn base() -> String {
    ".".into()
}
fn limit() -> usize {
    100
}
fn yes() -> bool {
    true
}

pub(crate) struct Query {
    pub path: String,
    matcher: Option<GlobMatcher>,
    regex: Option<Regex>,
    limit: usize,
    hidden: bool,
}
impl Query {
    pub fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        let query = match name {
            "glob" => {
                let input: GlobInput =
                    serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                Self {
                    path: input.path,
                    matcher: Some(glob(&input.pattern)?),
                    regex: None,
                    limit: input.limit,
                    hidden: input.include_hidden,
                }
            }
            "grep" => {
                let input: GrepInput =
                    serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
                if input.pattern.len() > 4096 {
                    return Err(ToolError::InvalidInput);
                }
                let regex = RegexBuilder::new(&input.pattern)
                    .case_insensitive(!input.case_sensitive)
                    .size_limit(1024 * 1024)
                    .build()
                    .map_err(|_| ToolError::InvalidInput)?;
                Self {
                    path: input.path,
                    matcher: input.glob.map(|pattern| glob(&pattern)).transpose()?,
                    regex: Some(regex),
                    limit: input.limit,
                    hidden: input.include_hidden,
                }
            }
            _ => return Err(ToolError::Unsupported),
        };
        if !(1..=500).contains(&query.limit) {
            return Err(ToolError::InvalidInput);
        }
        Ok(query)
    }
}
fn glob(pattern: &str) -> Result<GlobMatcher, ToolError> {
    if pattern.is_empty()
        || pattern.len() > 4096
        || pattern.starts_with('/')
        || pattern.split('/').any(|p| p == "..")
    {
        return Err(ToolError::InvalidInput);
    }
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|_| ToolError::InvalidInput)
}

/// Scoped capability walking, not a shell. Each child is opened with nofollow
/// relative to its pinned parent; permission is checked before file content IO.
pub(crate) struct Scope<'a> {
    pub root: &'a Dir,
    pub workspace: &'a Path,
    pub policy: &'a Policy,
    pub protected: &'a [PathBuf],
}

pub(crate) fn apply(
    scope: Scope<'_>,
    relative: &Path,
    name: &str,
    query: Query,
    cancel: &CancellationToken,
) -> Result<Value, ToolError> {
    let Scope {
        root,
        workspace,
        policy,
        protected,
    } = scope;
    let mut start = root.try_clone()?;
    for part in relative.components() {
        start = start.open_dir_nofollow(Path::new(part.as_os_str()))?;
    }
    let mut stack = vec![(start, relative.to_owned(), 0usize)];
    let mut results = Vec::new();
    let mut output_bytes = 0;
    let mut visited = 0;
    let mut files = 0;
    let mut read_bytes = 0;
    let mut skipped_policy = 0;
    let mut skipped_io = 0;
    let mut truncated = false;
    'walk: while let Some((directory, path, depth)) = stack.pop() {
        if cancel.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        let mut entries = Vec::new();
        for entry in directory.entries()? {
            if visited >= 10000 || entries.len() >= 1024 {
                truncated = true;
                break;
            }
            visited += 1;
            entries.push(entry?);
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if cancel.is_cancelled() {
                return Err(ToolError::Interrupted);
            }
            let filename = entry.file_name();
            let Some(filename) = filename.to_str() else {
                skipped_io += 1;
                continue;
            };
            if (!query.hidden && filename.starts_with('.'))
                || [".git", "target", "node_modules"].contains(&filename)
            {
                continue;
            }
            let child = path.join(filename);
            let parts = child
                .components()
                .map(|part| part.as_os_str().to_str().ok_or(ToolError::InvalidInput))
                .collect::<Result<Vec<_>, _>>()?;
            let resource = parts.join("/");
            if resource.len() > 4096 {
                truncated = true;
                continue;
            }
            if protected.contains(&workspace.join(&child))
                || policy.evaluate(name, &resource, Access::Read) != Decision::Allow
            {
                skipped_policy += 1;
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth >= 16 || stack.len() >= 32 {
                    truncated = true;
                    continue;
                }
                match directory.open_dir_nofollow(filename) {
                    Ok(dir) => stack.push((dir, child, depth + 1)),
                    Err(_) => skipped_io += 1,
                }
                continue;
            }
            if !kind.is_file()
                || query
                    .matcher
                    .as_ref()
                    .is_some_and(|matcher| !matcher.is_match(&resource))
            {
                continue;
            }
            files += 1;
            if files > 1000 {
                truncated = true;
                break 'walk;
            }
            if let Some(regex) = &query.regex {
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                let file = match directory.open_with(filename, &options) {
                    Ok(file) => file,
                    Err(_) => {
                        skipped_io += 1;
                        continue;
                    }
                };
                if file.metadata()?.len() > 1024 * 1024 {
                    skipped_io += 1;
                    continue;
                }
                let mut bytes = Vec::new();
                file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
                read_bytes += bytes.len();
                if read_bytes > 16 * 1024 * 1024 {
                    truncated = true;
                    break 'walk;
                }
                let Ok(text) = std::str::from_utf8(&bytes) else {
                    skipped_io += 1;
                    continue;
                };
                for (line, text) in text.lines().enumerate() {
                    if cancel.is_cancelled() {
                        return Err(ToolError::Interrupted);
                    }
                    if !regex.is_match(text) {
                        continue;
                    }
                    let preview: String = text.chars().take(512).collect();
                    let result = json!({"path":resource,"line":line+1,"text":preview,"line_truncated":text.chars().count()>512});
                    output_bytes += serde_json::to_vec(&result)
                        .map_err(|_| ToolError::InvalidInput)?
                        .len();
                    if output_bytes > 30000 || results.len() >= query.limit {
                        truncated = true;
                        break 'walk;
                    }
                    results.push(result);
                }
            } else {
                output_bytes += resource.len() + 8;
                if output_bytes > 30000 || results.len() >= query.limit {
                    truncated = true;
                    break 'walk;
                }
                results.push(json!({"path":resource}));
            }
        }
    }
    results.sort_by(|a, b| {
        a["path"]
            .as_str()
            .cmp(&b["path"].as_str())
            .then_with(|| a["line"].as_u64().cmp(&b["line"].as_u64()))
    });
    Ok(
        json!({"matches":results,"truncated":truncated,"skipped_policy":skipped_policy,"skipped_io":skipped_io}),
    )
}
