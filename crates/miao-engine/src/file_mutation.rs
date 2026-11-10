use crate::{permission::digest, tools::ToolError};
use cap_std::fs::{Dir, OpenOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteInput {
    pub path: String,
    pub text: String,
    pub expected_sha256: Option<String>,
}
/// The schema admits JSON `null` for a create-only write, and models write that
/// null as the string "null". The intent is unambiguous, so read every spelling
/// of "no expected hash" as absent instead of rejecting the whole call.
fn absent_hash(value: Option<String>) -> Option<String> {
    value.filter(|hash| {
        let hash = hash.trim();
        !hash.is_empty() && !hash.eq_ignore_ascii_case("null") && !hash.eq_ignore_ascii_case("none")
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditInput {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    pub expected_sha256: String,
    #[serde(default)]
    pub replace_all: bool,
}

/// The replaced text may be named explicitly or through the concise anchor
/// form; both normalize to the same exact-match edit.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditWire {
    path: String,
    #[serde(default)]
    old_string: Option<String>,
    #[serde(default)]
    new_string: Option<String>,
    #[serde(default)]
    anchor: Option<String>,
    #[serde(default)]
    new_text: Option<String>,
    expected_sha256: String,
    #[serde(default)]
    replace_all: bool,
}
impl EditWire {
    fn normalize(self, short_anchors: bool) -> Result<EditInput, ToolError> {
        if !short_anchors && (self.anchor.is_some() || self.new_text.is_some()) {
            return Err(ToolError::InvalidArgs(
                "short anchors are disabled by the ablation switch; name the replaced text old_string and the replacement new_string".into(),
            ));
        }
        // Each side of the replacement may be named either way: `old_string` or
        // `anchor`, `new_string` or `new_text`. One name per side is one
        // replacement; naming a side twice is what makes the edit ambiguous.
        let old_string = match (self.old_string, self.anchor) {
            (Some(text), None) | (None, Some(text)) => text,
            (Some(_), Some(_)) => {
                return Err(ToolError::InvalidArgs(
                    "pass the replaced text once, as old_string or anchor, not both".into(),
                ))
            }
            (None, None) => {
                return Err(ToolError::InvalidArgs(
                    "pass the replaced text as old_string or anchor".into(),
                ))
            }
        };
        let new_string = match (self.new_string, self.new_text) {
            (Some(text), None) | (None, Some(text)) => text,
            (Some(_), Some(_)) => {
                return Err(ToolError::InvalidArgs(
                    "pass the replacement once, as new_string or new_text, not both".into(),
                ))
            }
            (None, None) => {
                return Err(ToolError::InvalidArgs(
                    "pass the replacement as new_string or new_text".into(),
                ))
            }
        };
        Ok(EditInput {
            path: self.path,
            old_string,
            new_string,
            expected_sha256: self.expected_sha256,
            replace_all: self.replace_all,
        })
    }
}

pub(crate) enum Mutation {
    Write(WriteInput),
    Edit(EditInput),
}
impl Mutation {
    pub fn parse(name: &str, input: Value, short_anchors: bool) -> Result<Self, ToolError> {
        let mutation = match name {
            "write_file" => {
                let mut input: WriteInput = serde_json::from_value(input)
                    .map_err(|error| ToolError::InvalidArgs(error.to_string()))?;
                input.expected_sha256 = absent_hash(input.expected_sha256);
                Self::Write(input)
            }
            "edit_file" => Self::Edit(
                serde_json::from_value::<EditWire>(input)
                    .map_err(|error| ToolError::InvalidArgs(error.to_string()))?
                    .normalize(short_anchors)?,
            ),
            _ => return Err(ToolError::Unsupported),
        };
        let hash = match &mutation {
            Self::Write(v) => v.expected_sha256.as_deref(),
            Self::Edit(v) => Some(v.expected_sha256.as_str()),
        };
        if hash.is_some_and(|h| {
            h.len() != 64
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(ToolError::InvalidArgs(format!(
                "expected_sha256 must be the 64-character lowercase hex SHA-256 from read_file; got {:?}",
                hash.unwrap_or_default()
            )));
        }
        match &mutation {
            Self::Write(v) if v.text.len() > 32768 => {
                return Err(ToolError::InvalidArgs(format!(
                    "text is {} bytes; write_file accepts at most 32768",
                    v.text.len()
                )))
            }
            Self::Edit(v) if v.old_string.is_empty() => {
                return Err(ToolError::InvalidArgs(
                    "old_string must not be empty; to create a file use write_file".into(),
                ))
            }
            Self::Edit(v) if v.old_string.len() > 32768 || v.new_string.len() > 32768 => {
                return Err(ToolError::InvalidArgs(
                    "old_string and new_string must each be at most 32768 bytes".into(),
                ))
            }
            _ => {}
        }
        Ok(mutation)
    }
    pub fn path(&self) -> &str {
        match self {
            Self::Write(v) => &v.path,
            Self::Edit(v) => &v.path,
        }
    }
}

/// Own a newly created staging file only; never remove a preexisting file on
/// a create_new failure. All operations stay relative to the directory handle.
struct Staged<'a> {
    dir: &'a Dir,
    name: String,
}
impl Drop for Staged<'_> {
    fn drop(&mut self) {
        let _ = self.dir.remove_file(&self.name);
    }
}

/// Blocking commit section: callers must join it even when cancellation arrives.
/// Engine writers serialize externally. Existing-file checks are optimistic
/// against non-cooperating external writers, not a universal filesystem CAS.
pub(crate) fn apply(
    root: &Dir,
    relative: &Path,
    mutation: Mutation,
    snapshot: Option<String>,
) -> Result<Value, ToolError> {
    let parent_path = relative
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = relative.file_name().ok_or(ToolError::InvalidInput)?;
    let parent = root.open_dir(parent_path)?;
    let (original, permissions) = read(&parent, Path::new(name))?;
    let expected = match &mutation {
        Mutation::Write(v) => v.expected_sha256.clone(),
        Mutation::Edit(v) => Some(v.expected_sha256.clone()),
    };
    let current = original.as_ref().map(|bytes| digest(bytes));
    // A stale edit whose intent is unambiguous is rebased onto the current
    // content by unique context anchors before the failure is returned.
    let rebase = if current.as_deref() != expected.as_deref() {
        match (&mutation, snapshot.as_deref()) {
            (Mutation::Edit(v), Some(snapshot)) if !v.replace_all => {
                let text = match original.as_ref() {
                    Some(bytes) => {
                        std::str::from_utf8(bytes).map_err(|_| ToolError::InvalidFile)?
                    }
                    None => return Err(ToolError::StaleFile),
                };
                match crate::edit_recovery::recover(snapshot, text, &v.old_string, &v.new_string) {
                    crate::edit_recovery::Recovery::Recovered { replaced, note } => {
                        Some((replaced, note))
                    }
                    crate::edit_recovery::Recovery::Refused(reason) => {
                        return Err(ToolError::StaleEditRecovery(reason.as_str()))
                    }
                    crate::edit_recovery::Recovery::Inapplicable => {
                        return Err(ToolError::StaleFile)
                    }
                }
            }
            _ => return Err(ToolError::StaleFile),
        }
    } else {
        None
    };
    // The digest of the drift the rebase read, kept for the result payload;
    // the post-write read below must not shadow it.
    let drift = current;
    // A rebased edit is committed against the drift it read, so the final
    // compare-and-swap still rejects a concurrent external write.
    let expected = if rebase.is_some() {
        drift.clone()
    } else {
        expected
    };
    let mut fuzzy: Option<String> = None;
    let text = match (&rebase, mutation) {
        (Some((replaced, _)), _) => replaced.clone(),
        (None, Mutation::Write(v)) => v.text,
        (None, Mutation::Edit(v)) => {
            let text = String::from_utf8(original.as_ref().ok_or(ToolError::StaleFile)?.clone())
                .map_err(|_| ToolError::InvalidFile)?;
            let count = text.matches(&v.old_string).count();
            if count == 0 {
                // The fingerprint matched, so the file is exactly what the
                // model read; an absent old_string is a transcription slip,
                // and a unique whitespace-insensitive target is recoverable
                // without a re-read turn. Fuzzy never runs across drift: a
                // digest mismatch is the rebase path's failure to refuse.
                let regions = fuzzy_regions(&text, &v.old_string);
                if regions.is_empty() {
                    return Err(ToolError::AmbiguousEdit);
                }
                if !v.replace_all && regions.len() > 1 {
                    return Err(ToolError::AmbiguousFuzzy(ambiguous_fuzzy_message(
                        &regions,
                        &v.old_string,
                    )));
                }
                fuzzy = Some(fuzzy_note(&regions, &v.old_string));
                replace_regions(&text, &regions, &v.new_string)
            } else if count == 1 || v.replace_all {
                if v.replace_all {
                    text.replace(&v.old_string, &v.new_string)
                } else {
                    text.replacen(&v.old_string, &v.new_string, 1)
                }
            } else {
                return Err(ToolError::AmbiguousEdit);
            }
        }
    };
    if text.len() > MAX_MUTATION_BYTES {
        return Err(ToolError::InvalidFile);
    }
    let temporary = format!(".miao-engine-{}.tmp", uuid::Uuid::new_v4());
    let mut file = parent.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
    let staged = Staged {
        dir: &parent,
        name: temporary,
    };
    file.write_all(text.as_bytes())?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    file.sync_all()?;
    drop(file);
    let (committed, _) = read(&parent, Path::new(name))?;
    if committed.as_ref().map(|bytes| digest(bytes)).as_deref() != expected.as_deref() {
        return Err(ToolError::StaleFile);
    }
    if original.is_none() {
        // Hard-link publication is atomic no-clobber, unlike exists+rename.
        parent.hard_link(&staged.name, &parent, name).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                ToolError::StaleFile
            } else {
                ToolError::Io(e)
            }
        })?;
        parent.remove_file(&staged.name)?;
    } else {
        parent.rename(&staged.name, &parent, name)?;
    }
    // Dir may be an O_PATH capability on Linux; open a readable directory FD
    // for fsync instead. After publication an fsync failure is a durability
    // warning about an applied write, never a pre-effect retryable failure.
    #[cfg(unix)]
    let durability_error = parent
        .open(".")
        .and_then(|file| file.sync_all())
        .err()
        .map(|error| error.to_string());
    #[cfg(not(unix))]
    let durability_error: Option<String> = None;
    let durability = if durability_error.is_some() {
        "unknown"
    } else if cfg!(unix) {
        "synced"
    } else {
        "file_synced"
    };
    let mut result = json!({"sha256":digest(text.as_bytes()),"bytes":text.len(),"applied":true,"durability":durability,"durability_error":durability_error});
    // A rebase shows the drift it replaced in this diff, not just the span the
    // model asked for, so the host renders what actually landed on disk.
    let before = original
        .as_ref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .unwrap_or_default();
    let action = if original.is_none() {
        "create"
    } else {
        "update"
    };
    if let Some(entry) =
        crate::display_diff::file(before, &text, &relative.to_string_lossy(), action)
    {
        result["_display"] = crate::display_diff::files(vec![entry]);
    }
    if let Some((_, note)) = rebase {
        // The diff the model gets must show the rebase and the drift it
        // replaced, not just the requested span.
        result["rebased"] = json!(true);
        result["note"] = json!(note);
        result["previous_sha256"] = json!(drift);
    }
    if let Some(note) = fuzzy {
        result["fuzzy"] = json!(true);
        result["note"] = json!(note);
    }
    Ok(result)
}

/// One whitespace-insensitive candidate for an absent old_string: a
/// contiguous line window whose lines equal the needle's lines after
/// trimming each line. `line` is the 1-based start, `span` the byte range
/// to replace.
struct FuzzyRegion {
    line: usize,
    span: std::ops::Range<usize>,
}

/// Contiguous line windows matching the needle ignoring leading and
/// trailing whitespace per line. A needle whose every line trims empty
/// matches nothing: it would match every blank stretch in the file.
fn fuzzy_regions(text: &str, needle: &str) -> Vec<FuzzyRegion> {
    let target: Vec<&str> = needle
        .strip_suffix('\n')
        .unwrap_or(needle)
        .split('\n')
        .collect();
    if target.iter().all(|line| line.trim().is_empty()) {
        return Vec::new();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut regions = Vec::new();
    for start in 0..lines.len().saturating_sub(target.len() - 1) {
        let window = &lines[start..start + target.len()];
        if window
            .iter()
            .zip(target.iter())
            .all(|(line, want)| line.trim() == want.trim())
        {
            let byte_start = lines[..start].iter().map(|line| line.len() + 1).sum();
            let width = window.iter().map(|line| line.len() + 1).sum::<usize>() - 1;
            regions.push(FuzzyRegion {
                line: start + 1,
                span: byte_start..byte_start + width,
            });
        }
    }
    regions
}

fn replace_regions(text: &str, regions: &[FuzzyRegion], replacement: &str) -> String {
    let mut output = text.to_owned();
    // Right to left, so earlier byte spans stay valid.
    for region in regions.iter().rev() {
        output.replace_range(region.span.clone(), replacement);
    }
    output
}

fn needle_lines(needle: &str) -> usize {
    needle
        .strip_suffix('\n')
        .unwrap_or(needle)
        .split('\n')
        .count()
}

fn render_region(region: &FuzzyRegion, lines: usize) -> String {
    let end = region.line + lines - 1;
    if lines == 1 {
        format!("{}", region.line)
    } else {
        format!("{}-{}", region.line, end)
    }
}

fn ambiguous_fuzzy_message(regions: &[FuzzyRegion], needle: &str) -> String {
    let lines = needle_lines(needle);
    let ranges = regions
        .iter()
        .map(|region| render_region(region, lines))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "old_string is absent; {} whitespace-insensitive candidate region{} at line{} {ranges}; pass more surrounding lines or replace_all=true",
        regions.len(),
        if regions.len() == 1 { "" } else { "s" },
        if regions.len() == 1 { "" } else { "s" },
    )
}

fn fuzzy_note(regions: &[FuzzyRegion], needle: &str) -> String {
    let lines = needle_lines(needle);
    let ranges = regions
        .iter()
        .map(|region| render_region(region, lines))
        .collect::<Vec<_>>()
        .join(", ");
    if regions.len() == 1 {
        format!(
            "old_string did not occur exactly; the unique whitespace-insensitive match at line {ranges} was replaced. Leading and trailing whitespace per line was ignored when matching."
        )
    } else {
        format!(
            "old_string did not occur exactly; {} whitespace-insensitive matches at line{} {ranges} were all replaced. Leading and trailing whitespace per line was ignored when matching.",
            regions.len(),
            if regions.len() == 1 { "" } else { "s" },
        )
    }
}

/// Existing files and mutation results may be much larger than a single tool
/// input; the per-string input bounds stay at 32 KiB, but a small edit must be
/// applicable to a large file. Matches the 1 MiB line-window read bound.
const MAX_MUTATION_BYTES: usize = 1024 * 1024;

fn read(
    parent: &Dir,
    name: &Path,
) -> Result<(Option<Vec<u8>>, Option<cap_std::fs::Permissions>), ToolError> {
    let metadata = match parent.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((None, None)),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MUTATION_BYTES as u64
    {
        return Err(ToolError::InvalidFile);
    }
    let permissions = metadata.permissions();
    let file = parent.open(name)?;
    let mut bytes = Vec::new();
    // The read bound must follow MAX_MUTATION_BYTES; a fixed 32 KiB take would
    // silently truncate a larger file and make its fingerprint unmatchable.
    file.take(MAX_MUTATION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_MUTATION_BYTES || std::str::from_utf8(&bytes).is_err() {
        return Err(ToolError::InvalidFile);
    }
    Ok((Some(bytes), Some(permissions)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_edit_applies_to_a_large_file() {
        let dir = tempfile::tempdir().unwrap();
        // Larger than one tool input, smaller than the mutation bound.
        let body = (0..4000)
            .map(|index| {
                format!(
                    "export function handler{index}(value: number) {{ return value + {index} }}\n"
                )
            })
            .collect::<String>()
            + "export function shift(table: number[], key: number) { return table[key + 1] }\n";
        std::fs::write(dir.path().join("registry.ts"), &body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"registry.ts",
                "old_string":"return table[key + 1]",
                "new_string":"return table[key]",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        let applied = apply(&root, Path::new("registry.ts"), mutation, None).unwrap();
        assert_eq!(applied["applied"], json!(true), "tool result: {applied}");
        let written = std::fs::read_to_string(dir.path().join("registry.ts")).unwrap();
        assert!(written.contains("return table[key]"));
        assert!(written.contains("handler3999"));
    }

    #[test]
    fn multi_byte_text_survives_an_edit_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = "标题 中文 line\n组合字符: e\u{301}clair café\n";
        let suffix = "尾行 tail 👨‍👩‍👧‍👦 naïve\n";
        let body = format!("{prefix}anchor 中文\n{suffix}");
        std::fs::write(dir.path().join("note.md"), &body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"note.md",
                "old_string":"anchor",
                "new_string":"锚点 🇨🇳",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        let applied = apply(&root, Path::new("note.md"), mutation, None).unwrap();
        assert_eq!(applied["applied"], json!(true), "tool result: {applied}");
        let written = std::fs::read(dir.path().join("note.md")).unwrap();
        let expected = body.replace("anchor", "锚点 🇨🇳");
        assert_eq!(written, expected.as_bytes());
        assert!(written.starts_with(prefix.as_bytes()));
        assert!(written.ends_with(suffix.as_bytes()));
    }

    #[test]
    fn a_unique_whitespace_drifted_target_is_recovered_and_explained() {
        let dir = tempfile::tempdir().unwrap();
        let body = "fn kept() {\n    work();\n}\nfn tail() {}\n";
        std::fs::write(dir.path().join("src.rs"), body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        // The model transcribed the target with a tab, so the needle is not
        // an exact substring and only the whitespace-insensitive match lands.
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"src.rs",
                "old_string":"\twork();",
                "new_string":"work(1);",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        let applied = apply(&root, Path::new("src.rs"), mutation, None).unwrap();
        assert_eq!(applied["fuzzy"], json!(true), "tool result: {applied}");
        assert!(applied["note"]
            .as_str()
            .unwrap()
            .contains("whitespace-insensitive"));
        let written = std::fs::read_to_string(dir.path().join("src.rs")).unwrap();
        assert_eq!(
            written, "fn kept() {\nwork(1);\n}\nfn tail() {}\n",
            "matching ignores per-line whitespace; the replacement does not re-indent"
        );
    }

    #[test]
    fn an_ambiguous_fuzzy_target_is_refused_with_candidate_lines() {
        let dir = tempfile::tempdir().unwrap();
        let body = "if a {\n    ok()\n}\nif b {\n\tok()\n}\n";
        std::fs::write(dir.path().join("src.rs"), body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"src.rs",
                "old_string":"  ok()  ",
                "new_string":"ok(1)",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        let error = apply(&root, Path::new("src.rs"), mutation, None).unwrap_err();
        let ToolError::AmbiguousFuzzy(message) = error else {
            panic!("expected an ambiguous fuzzy refusal, got {error}");
        };
        assert!(message.contains("lines 2, 5"), "message: {message}");
        assert!(message.contains("replace_all"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.rs")).unwrap(),
            body,
            "a refused edit must not touch the file"
        );
    }

    #[test]
    fn an_exact_match_never_goes_fuzzy() {
        let dir = tempfile::tempdir().unwrap();
        let body = "alpha\nbeta\n";
        std::fs::write(dir.path().join("f.txt"), body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"beta",
                "new_string":"BETA",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        let applied = apply(&root, Path::new("f.txt"), mutation, None).unwrap();
        assert!(applied.get("fuzzy").is_none(), "tool result: {applied}");
    }

    #[test]
    fn fuzzy_is_inapplicable_across_drift() {
        // A digest mismatch is the rebase path's failure to refuse: fuzzy must
        // not paper over drift, even when the target would match uniquely.
        let dir = tempfile::tempdir().unwrap();
        let body = "alpha\nbeta\n";
        let drifted = "alpha\n beta \n";
        std::fs::write(dir.path().join("f.txt"), body).unwrap();
        let root = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let mutation = Mutation::parse(
            "edit_file",
            json!({
                "path":"f.txt",
                "old_string":"beta",
                "new_string":"BETA",
                "expected_sha256": digest(body.as_bytes()),
            }),
            true,
        )
        .unwrap();
        std::fs::write(dir.path().join("f.txt"), drifted).unwrap();
        let error = apply(&root, Path::new("f.txt"), mutation, None).unwrap_err();
        assert!(matches!(error, ToolError::StaleFile), "got {error}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            drifted,
            "a refused edit must not touch the file"
        );
    }

    #[test]
    fn fuzzy_regions_find_unique_and_multiple_targets() {
        let text = "one\n  two  \nthree\n\ttwo\n";
        let regions = fuzzy_regions(text, "two");
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].line, 2);
        assert_eq!(regions[1].line, 4);
        let replaced = replace_regions(text, &regions, "TWO");
        assert_eq!(replaced, "one\nTWO\nthree\nTWO\n");
        // Trimming makes every whitespace spelling of a line equivalent.
        assert_eq!(fuzzy_regions(text, "  two  ").len(), 2);
    }

    #[test]
    fn fuzzy_regions_normalize_a_trailing_newline_needle() {
        let text = "alpha\nbeta\ngamma\n";
        let regions = fuzzy_regions(text, "beta\n");
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].line, 2);
        let replaced = replace_regions(text, &regions, "B");
        assert_eq!(replaced, "alpha\nB\ngamma\n");
    }

    #[test]
    fn fuzzy_regions_reject_blank_and_offcontent_targets() {
        assert!(fuzzy_regions("a\n\nb\n", "\n\n").is_empty());
        assert!(fuzzy_regions("alpha\nbeta\n", "alpha\nBETA\n").is_empty());
        // Multi-byte lines keep byte spans on char boundaries.
        let text = "标题\n    中文行    \n尾\n";
        let regions = fuzzy_regions(text, "中文行");
        assert_eq!(regions.len(), 1);
        assert_eq!(replace_regions(text, &regions, "改"), "标题\n改\n尾\n");
    }
}
