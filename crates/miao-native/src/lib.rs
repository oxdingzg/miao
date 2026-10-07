//! `miao-native` PoC: a Rust port of the pure edit-matching pipeline in
//! `packages/miao/src/tool/edit.ts`, plus diff statistics and unified patch
//! generation. The native side performs pure functions only: no file IO, no
//! Effect, no session state.

use memchr::memmem;
use napi_derive::napi;
use regex::Regex;
use similar::{ChangeTag, TextDiff};
use std::sync::OnceLock;

const IDENTICAL: &str = "No changes to apply: oldString and newString are identical.";
const EMPTY_OLD: &str = "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.";
const DISPROPORTIONATE: &str = "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.";
const NOT_FOUND: &str =
    "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.";
const MULTIPLE: &str =
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.";

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD: f64 = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD: f64 = 0.65;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditError {
    Identical,
    EmptyOld,
    Disproportionate,
    NotFound,
    Multiple,
}

impl EditError {
    pub fn message(self) -> &'static str {
        match self {
            EditError::Identical => IDENTICAL,
            EditError::EmptyOld => EMPTY_OLD,
            EditError::Disproportionate => DISPROPORTIONATE,
            EditError::NotFound => NOT_FOUND,
            EditError::Multiple => MULTIPLE,
        }
    }
}

fn whitespace_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("valid whitespace regex"))
}

fn escape_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\\(n|t|r|'|"|`|\\|\n|\$)"#).expect("valid escape regex"))
}

fn normalize_whitespace(text: &str) -> String {
    whitespace_re().replace_all(text, " ").trim().to_string()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return a.len().max(b.len());
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

fn slice_span(content: &str, lines: &[&str], start_line: usize, end_line: usize) -> String {
    let mut match_start = 0usize;
    for line in &lines[..start_line] {
        match_start += line.len() + 1;
    }
    let mut match_end = match_start;
    for k in start_line..=end_line {
        match_end += lines[k].len();
        if k < end_line {
            match_end += 1;
        }
    }
    content[match_start..match_end].to_string()
}

fn simple(_content: &str, find: &str) -> Vec<String> {
    vec![find.to_string()]
}

fn line_trimmed(content: &str, find: &str) -> Vec<String> {
    let original: Vec<&str> = content.split('\n').collect();
    let mut search: Vec<&str> = find.split('\n').collect();
    if search.last() == Some(&"") {
        search.pop();
    }
    if search.is_empty() || search.len() > original.len() {
        return Vec::new();
    }
    let search_trimmed: Vec<&str> = search.iter().map(|line| line.trim()).collect();
    let mut out = Vec::new();
    for i in 0..=(original.len() - search.len()) {
        let matches = search_trimmed
            .iter()
            .enumerate()
            .all(|(j, needle)| original[i + j].trim() == *needle);
        if matches {
            out.push(slice_span(content, &original, i, i + search.len() - 1));
        }
    }
    out
}

fn block_anchor(content: &str, find: &str) -> Vec<String> {
    let original: Vec<&str> = content.split('\n').collect();
    let mut search: Vec<&str> = find.split('\n').collect();
    if search.len() < 3 {
        return Vec::new();
    }
    if search.last() == Some(&"") {
        search.pop();
    }
    if search.len() < 2 {
        return Vec::new();
    }

    let first_line = search[0].trim();
    let last_line = search[search.len() - 1].trim();
    let search_block = search.len();
    let max_delta = std::cmp::max(1, search_block / 4) as isize;

    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for i in 0..original.len() {
        if original[i].trim() != first_line {
            continue;
        }
        let mut j = i + 2;
        while j < original.len() {
            if original[j].trim() == last_line {
                let actual = (j - i + 1) as isize;
                if (actual - search_block as isize).abs() <= max_delta {
                    candidates.push((i, j));
                }
                break;
            }
            j += 1;
        }
    }

    if candidates.is_empty() {
        return Vec::new();
    }

    let similarity_of = |start_line: usize, end_line: usize| -> f64 {
        let actual_block = end_line - start_line + 1;
        let lines_to_check = std::cmp::min(
            search_block.saturating_sub(2),
            actual_block.saturating_sub(2),
        );
        if lines_to_check == 0 {
            return 1.0;
        }
        let mut similarity = 0.0f64;
        let mut j = 1;
        while j < search_block - 1 && j < actual_block - 1 {
            let original_line = original[start_line + j].trim();
            let search_line = search[j].trim();
            let max_len = std::cmp::max(original_line.chars().count(), search_line.chars().count());
            if max_len != 0 {
                similarity += 1.0 - levenshtein(original_line, search_line) as f64 / max_len as f64;
            }
            j += 1;
        }
        similarity / lines_to_check as f64
    };

    if candidates.len() == 1 {
        let (start_line, end_line) = candidates[0];
        if similarity_of(start_line, end_line) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD {
            return vec![slice_span(content, &original, start_line, end_line)];
        }
        return Vec::new();
    }

    let mut best: Option<(usize, usize)> = None;
    let mut max_similarity = -1.0f64;
    for &(start_line, end_line) in &candidates {
        let similarity = similarity_of(start_line, end_line);
        if similarity > max_similarity {
            max_similarity = similarity;
            best = Some((start_line, end_line));
        }
    }
    if max_similarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD {
        if let Some((start_line, end_line)) = best {
            return vec![slice_span(content, &original, start_line, end_line)];
        }
    }
    Vec::new()
}

fn whitespace_normalized(content: &str, find: &str) -> Vec<String> {
    let normalized_find = normalize_whitespace(find);
    let lines: Vec<&str> = content.split('\n').collect();
    let mut out = Vec::new();

    for line in &lines {
        if normalize_whitespace(line) == normalized_find {
            out.push((*line).to_string());
            continue;
        }
        let normalized_line = normalize_whitespace(line);
        if normalized_line.contains(&normalized_find) {
            let words: Vec<&str> = find.trim().split_whitespace().collect();
            if !words.is_empty() {
                let pattern = words
                    .iter()
                    .map(|word| regex::escape(word))
                    .collect::<Vec<_>>()
                    .join(r"\s+");
                if let Ok(re) = Regex::new(&pattern) {
                    if let Some(m) = re.find(line) {
                        out.push(m.as_str().to_string());
                    }
                }
            }
        }
    }

    let find_lines: Vec<&str> = find.split('\n').collect();
    if find_lines.len() > 1 && find_lines.len() <= lines.len() {
        for i in 0..=(lines.len() - find_lines.len()) {
            let block = lines[i..i + find_lines.len()].join("\n");
            if normalize_whitespace(&block) == normalized_find {
                out.push(block);
            }
        }
    }

    out
}

fn indentation_flexible(content: &str, find: &str) -> Vec<String> {
    fn remove_indentation(text: &str) -> String {
        let lines: Vec<&str> = text.split('\n').collect();
        let non_empty: Vec<&&str> = lines
            .iter()
            .filter(|line| !line.trim().is_empty())
            .collect();
        if non_empty.is_empty() {
            return text.to_string();
        }
        let min_indent = non_empty
            .iter()
            .map(|line| line.len() - line.trim_start().len())
            .min()
            .unwrap_or(0);
        lines
            .iter()
            .map(|line| {
                if line.trim().is_empty() {
                    (*line).to_string()
                } else {
                    line[min_indent.min(line.len())..].to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    let normalized_find = remove_indentation(find);
    let content_lines: Vec<&str> = content.split('\n').collect();
    let find_lines: Vec<&str> = find.split('\n').collect();
    let mut out = Vec::new();
    if find_lines.is_empty() || find_lines.len() > content_lines.len() {
        return out;
    }
    for i in 0..=(content_lines.len() - find_lines.len()) {
        let block = content_lines[i..i + find_lines.len()].join("\n");
        if remove_indentation(&block) == normalized_find {
            out.push(block);
        }
    }
    out
}

fn unescape_string(text: &str) -> String {
    escape_re()
        .replace_all(text, |caps: &regex::Captures| {
            match caps.get(1).map(|m| m.as_str()).unwrap_or("") {
                "n" | "\n" => "\n".to_string(),
                "t" => "\t".to_string(),
                "r" => "\r".to_string(),
                "'" => "'".to_string(),
                "\"" => "\"".to_string(),
                "`" => "`".to_string(),
                "\\" => "\\".to_string(),
                "$" => "$".to_string(),
                other => other.to_string(),
            }
        })
        .to_string()
}

fn escape_normalized(content: &str, find: &str) -> Vec<String> {
    let unescaped_find = unescape_string(find);
    let mut out = Vec::new();
    if content.contains(&unescaped_find) {
        out.push(unescaped_find.clone());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let find_lines: Vec<&str> = unescaped_find.split('\n').collect();
    if !find_lines.is_empty() && find_lines.len() <= lines.len() {
        for i in 0..=(lines.len() - find_lines.len()) {
            let block = lines[i..i + find_lines.len()].join("\n");
            if unescape_string(&block) == unescaped_find {
                out.push(block);
            }
        }
    }
    out
}

fn trimmed_boundary(content: &str, find: &str) -> Vec<String> {
    let trimmed_find = find.trim();
    if trimmed_find == find {
        return Vec::new();
    }
    let mut out = Vec::new();
    if content.contains(trimmed_find) {
        out.push(trimmed_find.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let find_lines: Vec<&str> = find.split('\n').collect();
    if !find_lines.is_empty() && find_lines.len() <= lines.len() {
        for i in 0..=(lines.len() - find_lines.len()) {
            let block = lines[i..i + find_lines.len()].join("\n");
            if block.trim() == trimmed_find {
                out.push(block);
            }
        }
    }
    out
}

fn context_aware(content: &str, find: &str) -> Vec<String> {
    let mut find_lines: Vec<&str> = find.split('\n').collect();
    if find_lines.len() < 3 {
        return Vec::new();
    }
    if find_lines.last() == Some(&"") {
        find_lines.pop();
    }
    if find_lines.len() < 2 {
        return Vec::new();
    }
    let content_lines: Vec<&str> = content.split('\n').collect();
    let first_line = find_lines[0].trim();
    let last_line = find_lines[find_lines.len() - 1].trim();

    for i in 0..content_lines.len() {
        if content_lines[i].trim() != first_line {
            continue;
        }
        let mut j = i + 2;
        while j < content_lines.len() {
            if content_lines[j].trim() == last_line {
                let block_lines = &content_lines[i..=j];
                if block_lines.len() == find_lines.len() {
                    let mut matching = 0usize;
                    let mut total = 0usize;
                    for k in 1..block_lines.len() - 1 {
                        let block_line = block_lines[k].trim();
                        let find_line = find_lines[k].trim();
                        if !block_line.is_empty() || !find_line.is_empty() {
                            total += 1;
                            if block_line == find_line {
                                matching += 1;
                            }
                        }
                    }
                    if total == 0 || matching as f64 / total as f64 >= 0.5 {
                        return vec![block_lines.join("\n")];
                    }
                }
                break;
            }
            j += 1;
        }
    }
    Vec::new()
}

fn multi_occurrence(content: &str, find: &str) -> Vec<String> {
    if content.contains(find) {
        vec![find.to_string()]
    } else {
        Vec::new()
    }
}

fn is_disproportionate_match(search: &str, old_string: &str) -> bool {
    let old_lines = old_string.split('\n').count();
    let search_lines = search.split('\n').count();
    if search_lines >= std::cmp::max(old_lines + 3, old_lines * 2) {
        return true;
    }
    if old_lines == 1 {
        return false;
    }
    search.trim().chars().count()
        > std::cmp::max(
            old_string.trim().chars().count() + 500,
            old_string.trim().chars().count() * 4,
        )
}

/// Pure port of `replace()` in `packages/miao/src/tool/edit.ts`.
pub fn replace(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<String, EditError> {
    if old_string == new_string {
        return Err(EditError::Identical);
    }
    if old_string.is_empty() {
        return Err(EditError::EmptyOld);
    }

    type Replacer = fn(&str, &str) -> Vec<String>;
    const REPLACERS: [Replacer; 9] = [
        simple,
        line_trimmed,
        block_anchor,
        whitespace_normalized,
        indentation_flexible,
        escape_normalized,
        trimmed_boundary,
        context_aware,
        multi_occurrence,
    ];

    let mut not_found = true;
    for replacer in REPLACERS {
        for search in replacer(content, old_string) {
            let Some(index) = memmem::find(content.as_bytes(), search.as_bytes()) else {
                continue;
            };
            not_found = false;
            if is_disproportionate_match(&search, old_string) {
                return Err(EditError::Disproportionate);
            }
            if replace_all {
                return Ok(content.replace(&search, new_string));
            }
            // `index` is already the leftmost occurrence, so uniqueness is just
            // "no further occurrence after index". Searching from index + 1
            // preserves JS lastIndexOf semantics for self-overlapping patterns.
            if memmem::find(&content.as_bytes()[index + 1..], search.as_bytes()).is_some() {
                continue;
            }
            let mut out = String::with_capacity(content.len() + new_string.len());
            out.push_str(&content[..index]);
            out.push_str(new_string);
            out.push_str(&content[index + search.len()..]);
            return Ok(out);
        }
    }

    if not_found {
        Err(EditError::NotFound)
    } else {
        Err(EditError::Multiple)
    }
}

fn compute_stats(before: &str, after: &str) -> (u32, u32) {
    let diff = TextDiff::from_lines(before, after);
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }
    (additions, deletions)
}

fn build_unified_patch(before: &str, after: &str, file_path: &str) -> String {
    let diff = TextDiff::from_lines(before, after);
    let hunks = diff.unified_diff().context_radius(4).to_string();
    if hunks.is_empty() {
        return String::new();
    }
    format!(
        "Index: {file}\n{separator}\n--- {file}\n+++ {file}\n{hunks}",
        file = file_path,
        separator = "=".repeat(67),
    )
}

#[napi(object)]
pub struct ApplyEditResult {
    pub content: String,
    pub additions: u32,
    pub deletions: u32,
}

#[napi(object)]
pub struct DiffStats {
    pub additions: u32,
    pub deletions: u32,
}

#[napi(js_name = "replaceOnly")]
pub fn replace_only(
    content: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> napi::Result<String> {
    replace(
        &content,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
    )
    .map_err(|error| napi::Error::from_reason(error.message()))
}

#[napi(js_name = "applyEdit")]
pub fn apply_edit(
    content: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> napi::Result<ApplyEditResult> {
    let result = replace(
        &content,
        &old_string,
        &new_string,
        replace_all.unwrap_or(false),
    )
    .map_err(|error| napi::Error::from_reason(error.message()))?;
    let (additions, deletions) = compute_stats(&content, &result);
    Ok(ApplyEditResult {
        content: result,
        additions,
        deletions,
    })
}

#[napi(js_name = "diffStats")]
pub fn diff_stats(before: String, after: String) -> DiffStats {
    let (additions, deletions) = compute_stats(&before, &after);
    DiffStats {
        additions,
        deletions,
    }
}

#[napi(js_name = "unifiedPatch")]
pub fn unified_patch(before: String, after: String, file_path: String) -> String {
    build_unified_patch(&before, &after, &file_path)
}

#[napi(object)]
pub struct PatchChunk {
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub change_context: Option<String>,
    pub is_end_of_file: Option<bool>,
}

#[napi(object)]
#[derive(Debug)]
pub struct DeriveResult {
    pub content: String,
    pub unified_diff: String,
    pub bom: bool,
}

fn split_bom(text: &str) -> (bool, &str) {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, text),
    }
}

fn normalize_unicode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => out.push('\''),
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => out.push('"'),
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => {
                out.push('-')
            }
            '\u{2026}' => out.push_str("..."),
            '\u{00a0}' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

fn try_match<F: Fn(&str, &str) -> bool>(
    lines: &[&str],
    pattern: &[&str],
    start: usize,
    eof: bool,
    compare: F,
) -> i64 {
    if eof && lines.len() >= pattern.len() {
        let from_end = lines.len() - pattern.len();
        if from_end >= start
            && pattern
                .iter()
                .enumerate()
                .all(|(j, p)| compare(lines[from_end + j], p))
        {
            return from_end as i64;
        }
    }
    if pattern.len() > lines.len() {
        return -1;
    }
    for i in start..=(lines.len() - pattern.len()) {
        if pattern
            .iter()
            .enumerate()
            .all(|(j, p)| compare(lines[i + j], p))
        {
            return i as i64;
        }
    }
    -1
}

fn seek_sequence(lines: &[&str], pattern: &[&str], start: usize, eof: bool) -> i64 {
    if pattern.is_empty() {
        return -1;
    }
    let exact = try_match(lines, pattern, start, eof, |a, b| a == b);
    if exact != -1 {
        return exact;
    }
    let rstrip = try_match(lines, pattern, start, eof, |a, b| {
        a.trim_end() == b.trim_end()
    });
    if rstrip != -1 {
        return rstrip;
    }
    let trim = try_match(lines, pattern, start, eof, |a, b| a.trim() == b.trim());
    if trim != -1 {
        return trim;
    }
    try_match(lines, pattern, start, eof, |a, b| {
        normalize_unicode(a.trim()) == normalize_unicode(b.trim())
    })
}

struct Replacement {
    start: usize,
    len: usize,
    lines: Vec<String>,
}

fn compute_replacements(
    original: &[&str],
    file_path: &str,
    chunks: &[PatchChunk],
) -> Result<Vec<Replacement>, String> {
    let lines = original;
    let mut replacements = Vec::new();
    let mut line_index = 0usize;

    for chunk in chunks {
        if let Some(context) = &chunk.change_context {
            let ctx = [context.as_str()];
            let index = seek_sequence(lines, &ctx, line_index, false);
            if index == -1 {
                return Err(format!("Failed to find context '{context}' in {file_path}"));
            }
            line_index = index as usize + 1;
        }

        if chunk.old_lines.is_empty() {
            let insertion = if !original.is_empty() && original[original.len() - 1].is_empty() {
                original.len() - 1
            } else {
                original.len()
            };
            replacements.push(Replacement {
                start: insertion,
                len: 0,
                lines: chunk.new_lines.clone(),
            });
            continue;
        }

        let mut pattern: Vec<&str> = chunk.old_lines.iter().map(String::as_str).collect();
        let mut new_slice = chunk.new_lines.clone();
        let eof = chunk.is_end_of_file.unwrap_or(false);
        let mut found = seek_sequence(lines, &pattern, line_index, eof);

        if found == -1 && !pattern.is_empty() && pattern[pattern.len() - 1].is_empty() {
            pattern.pop();
            if !new_slice.is_empty() && new_slice[new_slice.len() - 1].is_empty() {
                new_slice.pop();
            }
            found = seek_sequence(lines, &pattern, line_index, eof);
        }

        if found == -1 {
            return Err(format!(
                "Failed to find expected lines in {file_path}:\n{}",
                chunk.old_lines.join("\n")
            ));
        }

        replacements.push(Replacement {
            start: found as usize,
            len: pattern.len(),
            lines: new_slice,
        });
        line_index = found as usize + pattern.len();
    }

    replacements.sort_by_key(|replacement| replacement.start);
    Ok(replacements)
}

fn apply_replacements_into(original: &[&str], replacements: &[Replacement], out: &mut String) {
    let mut cursor = 0usize;
    for replacement in replacements {
        for line in &original[cursor..replacement.start] {
            out.push_str(line);
            out.push('\n');
        }
        for line in &replacement.lines {
            out.push_str(line);
            out.push('\n');
        }
        cursor = replacement.start + replacement.len;
    }
    for line in &original[cursor..] {
        out.push_str(line);
        out.push('\n');
    }
}

fn generate_unified_diff(old_content: &str, new_content: &str) -> String {
    let old_lines: Vec<&str> = old_content.split('\n').collect();
    let new_lines: Vec<&str> = new_content.split('\n').collect();
    let mut diff = String::with_capacity(old_content.len() + new_content.len() + 16);
    diff.push_str("@@ -1 +1 @@\n");
    let max_len = std::cmp::max(old_lines.len(), new_lines.len());
    let mut has_changes = false;
    for index in 0..max_len {
        let old_line = old_lines.get(index).copied().unwrap_or("");
        let new_line = new_lines.get(index).copied().unwrap_or("");
        if old_line != new_line {
            if !old_line.is_empty() {
                diff.push('-');
                diff.push_str(old_line);
                diff.push('\n');
            }
            if !new_line.is_empty() {
                diff.push('+');
                diff.push_str(new_line);
                diff.push('\n');
            }
            has_changes = true;
        } else if !old_line.is_empty() {
            diff.push(' ');
            diff.push_str(old_line);
            diff.push('\n');
        }
    }
    if has_changes {
        diff
    } else {
        String::new()
    }
}

fn derive_new_contents(
    chunks: &[PatchChunk],
    file_path: &str,
    original_text: &str,
) -> Result<DeriveResult, String> {
    let (original_bom, text) = split_bom(original_text);
    let mut original_lines: Vec<&str> = text.split('\n').collect();
    if original_lines
        .last()
        .map(|line| line.is_empty())
        .unwrap_or(false)
    {
        original_lines.pop();
    }

    let replacements = compute_replacements(&original_lines, file_path, chunks)?;

    let mut joined = String::with_capacity(text.len() + 64);
    apply_replacements_into(&original_lines, &replacements, &mut joined);

    let (next_bom, new_content) = split_bom(&joined);
    let unified_diff = generate_unified_diff(text, new_content);

    Ok(DeriveResult {
        content: new_content.to_string(),
        unified_diff,
        bom: original_bom || next_bom,
    })
}

#[napi(js_name = "deriveNewContents")]
pub fn derive_new_contents_napi(
    chunks: Vec<PatchChunk>,
    file_path: String,
    original_text: String,
) -> napi::Result<DeriveResult> {
    derive_new_contents(&chunks, &file_path, &original_text).map_err(napi::Error::from_reason)
}

#[napi(object)]
pub struct GitEntry {
    pub path: String,
    pub status: String,
}

fn git_status_entries(path: &str) -> Result<Vec<GitEntry>, String> {
    use gix::status::index_worktree::iter::Summary;

    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(|error| format!("failed to compute status: {error}"))?
        .into_index_worktree_iter(Vec::<gix::bstr::BString>::new())
        .map_err(|error| format!("failed to iterate status: {error}"))?;

    let mut entries = Vec::new();
    for item in iter {
        let item = item.map_err(|error| format!("failed to read status entry: {error}"))?;
        let status = match item.summary() {
            Some(Summary::Modified) | Some(Summary::TypeChange) | Some(Summary::Conflict) => {
                "modified"
            }
            Some(Summary::Added) => "added",
            Some(Summary::Removed) => "deleted",
            Some(Summary::Renamed) => "renamed",
            Some(Summary::Copied) => "copied",
            Some(Summary::IntentToAdd) | None => continue,
        };
        entries.push(GitEntry {
            path: item.rela_path().to_string(),
            status: status.to_string(),
        });
    }
    Ok(entries)
}

#[napi(js_name = "gitStatus")]
pub fn git_status(path: String) -> napi::Result<Vec<GitEntry>> {
    git_status_entries(&path).map_err(napi::Error::from_reason)
}

/// Async variant of [`git_status`] that runs on the libuv threadpool so large
/// repositories do not block the JS event loop.
pub struct GitStatusTask {
    path: String,
}

impl napi::Task for GitStatusTask {
    type Output = Vec<GitEntry>;
    type JsValue = Vec<GitEntry>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_status_entries(&self.path).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitStatusAsync")]
pub fn git_status_async(path: String) -> napi::bindgen_prelude::AsyncTask<GitStatusTask> {
    napi::bindgen_prelude::AsyncTask::new(GitStatusTask { path })
}

#[napi(object)]
pub struct GitBlob {
    pub content: String,
    pub binary: bool,
}

/// Resolve a revision to its full object id, matching `git rev-parse <rev>`.
fn git_rev_parse_impl(path: &str, rev: &str) -> Result<String, String> {
    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    let id = repo
        .rev_parse_single(gix::bstr::BStr::new(rev))
        .map_err(|error| format!("failed to resolve '{rev}': {error}"))?;
    Ok(id.to_string())
}

/// Read a file's content at a revision, matching `git show <rev>:<file>`.
fn git_blob_impl(path: &str, rev: &str, file: &str) -> Result<GitBlob, String> {
    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    let id = repo
        .rev_parse_single(gix::bstr::BStr::new(rev))
        .map_err(|error| format!("failed to resolve '{rev}': {error}"))?;
    let tree = repo
        .find_object(id)
        .map_err(|error| format!("failed to find object: {error}"))?
        .peel_to_tree()
        .map_err(|error| format!("failed to peel '{rev}' to a tree: {error}"))?;
    let entry = tree
        .lookup_entry_by_path(file)
        .map_err(|error| format!("failed to look up '{file}': {error}"))?
        .ok_or_else(|| format!("'{file}' not found at '{rev}'"))?;
    let object = entry
        .object()
        .map_err(|error| format!("failed to read blob for '{file}': {error}"))?;
    match String::from_utf8(object.data.clone()) {
        Ok(content) => Ok(GitBlob {
            content,
            binary: false,
        }),
        Err(_) => Ok(GitBlob {
            content: String::new(),
            binary: true,
        }),
    }
}

#[napi(js_name = "gitRevParse")]
pub fn git_rev_parse(path: String, rev: String) -> napi::Result<String> {
    git_rev_parse_impl(&path, &rev).map_err(napi::Error::from_reason)
}

/// Async variant that runs on the libuv threadpool so it does not block the JS event loop.
pub struct GitRevParseTask {
    path: String,
    rev: String,
}

impl napi::Task for GitRevParseTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_rev_parse_impl(&self.path, &self.rev).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitRevParseAsync")]
pub fn git_rev_parse_async(
    path: String,
    rev: String,
) -> napi::bindgen_prelude::AsyncTask<GitRevParseTask> {
    napi::bindgen_prelude::AsyncTask::new(GitRevParseTask { path, rev })
}

#[napi(js_name = "gitBlob")]
pub fn git_blob(path: String, rev: String, file: String) -> napi::Result<GitBlob> {
    git_blob_impl(&path, &rev, &file).map_err(napi::Error::from_reason)
}

/// Async variant that runs on the libuv threadpool so it does not block the JS event loop.
pub struct GitBlobTask {
    path: String,
    rev: String,
    file: String,
}

impl napi::Task for GitBlobTask {
    type Output = GitBlob;
    type JsValue = GitBlob;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_blob_impl(&self.path, &self.rev, &self.file).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitBlobAsync")]
pub fn git_blob_async(
    path: String,
    rev: String,
    file: String,
) -> napi::bindgen_prelude::AsyncTask<GitBlobTask> {
    napi::bindgen_prelude::AsyncTask::new(GitBlobTask { path, rev, file })
}

/// Paths with unstaged tracked changes, matching `git diff --name-only`
/// (modified, deleted, renamed, copied, type-changed; untracked excluded).
fn git_worktree_changes_impl(path: &str) -> Result<Vec<String>, String> {
    use gix::status::index_worktree::iter::Summary;

    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(|error| format!("failed to compute status: {error}"))?
        .into_index_worktree_iter(Vec::<gix::bstr::BString>::new())
        .map_err(|error| format!("failed to iterate status: {error}"))?;

    let mut paths = Vec::new();
    for item in iter {
        let item = item.map_err(|error| format!("failed to read status entry: {error}"))?;
        match item.summary() {
            Some(Summary::Modified)
            | Some(Summary::Removed)
            | Some(Summary::Renamed)
            | Some(Summary::Copied)
            | Some(Summary::TypeChange) => paths.push(item.rela_path().to_string()),
            _ => {}
        }
    }
    paths.sort();
    Ok(paths)
}

#[napi(js_name = "gitWorktreeChanges")]
pub fn git_worktree_changes(path: String) -> napi::Result<Vec<String>> {
    git_worktree_changes_impl(&path).map_err(napi::Error::from_reason)
}

pub struct GitWorktreeChangesTask {
    path: String,
}

impl napi::Task for GitWorktreeChangesTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_worktree_changes_impl(&self.path).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitWorktreeChangesAsync")]
pub fn git_worktree_changes_async(
    path: String,
) -> napi::bindgen_prelude::AsyncTask<GitWorktreeChangesTask> {
    napi::bindgen_prelude::AsyncTask::new(GitWorktreeChangesTask { path })
}

/// Find the merge base of two revisions, matching `git merge-base <a> <b>`.
fn git_merge_base_impl(path: &str, a: &str, b: &str) -> Result<String, String> {
    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    let one = repo
        .rev_parse_single(gix::bstr::BStr::new(a))
        .map_err(|error| format!("failed to resolve '{a}': {error}"))?
        .detach();
    let two = repo
        .rev_parse_single(gix::bstr::BStr::new(b))
        .map_err(|error| format!("failed to resolve '{b}': {error}"))?
        .detach();
    let base = repo
        .merge_base(one, two)
        .map_err(|error| format!("failed to find merge base of '{a}' and '{b}': {error}"))?;
    Ok(base.to_string())
}

#[napi(js_name = "gitMergeBase")]
pub fn git_merge_base(path: String, a: String, b: String) -> napi::Result<String> {
    git_merge_base_impl(&path, &a, &b).map_err(napi::Error::from_reason)
}

pub struct GitMergeBaseTask {
    path: String,
    a: String,
    b: String,
}

impl napi::Task for GitMergeBaseTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_merge_base_impl(&self.path, &self.a, &self.b).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitMergeBaseAsync")]
pub fn git_merge_base_async(
    path: String,
    a: String,
    b: String,
) -> napi::bindgen_prelude::AsyncTask<GitMergeBaseTask> {
    napi::bindgen_prelude::AsyncTask::new(GitMergeBaseTask { path, a, b })
}

/// Detect the dominant line ending from the first line break, matching the
/// TypeScript file-read normalization.
#[napi(js_name = "detectLineEnding")]
pub fn detect_line_ending(text: String) -> String {
    let bytes = text.as_bytes();
    for index in 0..bytes.len() {
        match bytes[index] {
            b'\r' => {
                return if bytes.get(index + 1) == Some(&b'\n') {
                    "crlf"
                } else {
                    "cr"
                }
                .to_string();
            }
            b'\n' => return "lf".to_string(),
            _ => {}
        }
    }
    "none".to_string()
}

/// Normalize all line endings to `lf` or `crlf`.
#[napi(js_name = "normalizeLineEndings")]
pub fn normalize_line_endings(text: String, eol: String) -> String {
    let lf = text.replace("\r\n", "\n").replace('\r', "\n");
    if eol == "crlf" {
        lf.replace('\n', "\r\n")
    } else {
        lf
    }
}

fn o200k() -> &'static tiktoken_rs::CoreBPE {
    static BPE: OnceLock<tiktoken_rs::CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::o200k_base().expect("o200k_base encoder"))
}

fn cl100k() -> &'static tiktoken_rs::CoreBPE {
    static BPE: OnceLock<tiktoken_rs::CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| tiktoken_rs::cl100k_base().expect("cl100k_base encoder"))
}

/// Count BPE tokens, matching `gpt-tokenizer` (`o200k_base` by default).
#[napi(js_name = "countTokens")]
pub fn count_tokens(text: String, encoding: Option<String>) -> u32 {
    let bpe = match encoding.as_deref() {
        Some("cl100k_base") => cl100k(),
        _ => o200k(),
    };
    bpe.encode_with_special_tokens(&text).len() as u32
}

#[napi(object)]
pub struct WalkOptions {
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
}

/// List files under `root` as sorted, forward-slash relative paths. Honors
/// `.gitignore` unless disabled; hidden files are skipped unless requested.
fn walk_files_impl(root: &str, hidden: bool, gitignore: bool) -> Result<Vec<String>, String> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(!hidden)
        .git_ignore(gitignore)
        .git_global(gitignore)
        .git_exclude(gitignore)
        .ignore(gitignore)
        .parents(gitignore)
        .follow_links(false);

    let mut paths = Vec::new();
    for entry in builder.build() {
        let entry = entry.map_err(|error| format!("failed to walk '{root}': {error}"))?;
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        paths.push(relative.to_string_lossy().replace('\\', "/"));
    }
    paths.sort();
    Ok(paths)
}

#[napi(js_name = "walkFiles")]
pub fn walk_files(root: String, options: Option<WalkOptions>) -> napi::Result<Vec<String>> {
    let hidden = options
        .as_ref()
        .and_then(|item| item.hidden)
        .unwrap_or(false);
    let gitignore = options
        .as_ref()
        .and_then(|item| item.gitignore)
        .unwrap_or(true);
    walk_files_impl(&root, hidden, gitignore).map_err(napi::Error::from_reason)
}

/// SHA-256 of UTF-8 bytes as lowercase hex, matching Node's
/// `crypto.createHash("sha256")`.
#[napi(js_name = "sha256Hex")]
pub fn sha256_hex(text: String) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// BLAKE3 of UTF-8 bytes as lowercase hex, for snapshot content hashing.
#[napi(js_name = "blake3Hex")]
pub fn blake3_hex(text: String) -> String {
    blake3::hash(text.as_bytes()).to_hex().to_string()
}

fn render_patch(file: &str, old: &str, new: &str) -> String {
    let diff = TextDiff::from_lines(old, new);
    let (from, to) = if old.is_empty() {
        ("/dev/null".to_string(), format!("b/{file}"))
    } else if new.is_empty() {
        (format!("a/{file}"), "/dev/null".to_string())
    } else {
        (format!("a/{file}"), format!("b/{file}"))
    };
    let mut out = format!("diff --git a/{file} b/{file}\n");
    if old.is_empty() {
        out.push_str("new file mode 100644\n");
    }
    if new.is_empty() {
        out.push_str("deleted file mode 100644\n");
    }
    out.push_str(
        &diff
            .unified_diff()
            .context_radius(3)
            .header(&from, &to)
            .to_string(),
    );
    out
}

/// Standard unified-diff text for unstaged tracked changes, applyable with
/// `git apply`. Rendering, not `git diff` byte parity.
fn git_diff_impl(path: &str) -> Result<String, String> {
    let repo = gix::open(path).map_err(|error| format!("failed to open repository: {error}"))?;
    drop(repo);
    let root = std::path::Path::new(path);
    let mut out = String::new();
    for file in git_worktree_changes_impl(path)? {
        let old = git_blob_impl(path, "HEAD", &file);
        let new_bytes = std::fs::read(root.join(&file)).ok();
        let old_binary = matches!(&old, Ok(blob) if blob.binary);
        let new_binary = new_bytes
            .as_deref()
            .map(|bytes| std::str::from_utf8(bytes).is_err())
            .unwrap_or(false);
        if old_binary || new_binary {
            out.push_str(&format!("Binary files a/{file} and b/{file} differ\n"));
            continue;
        }
        let old_text = match &old {
            Ok(blob) => blob.content.as_str(),
            Err(_) => "",
        };
        let new_text = new_bytes
            .as_deref()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_default();
        if old_text == new_text {
            continue;
        }
        out.push_str(&render_patch(&file, old_text, &new_text));
    }
    Ok(out)
}

#[napi(js_name = "gitDiff")]
pub fn git_diff(path: String) -> napi::Result<String> {
    git_diff_impl(&path).map_err(napi::Error::from_reason)
}

pub struct GitDiffTask {
    path: String,
}

impl napi::Task for GitDiffTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        git_diff_impl(&self.path).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "gitDiffAsync")]
pub fn git_diff_async(path: String) -> napi::bindgen_prelude::AsyncTask<GitDiffTask> {
    napi::bindgen_prelude::AsyncTask::new(GitDiffTask { path })
}

#[napi(object)]
pub struct ShellPart {
    pub kind: String,
    pub text: String,
}

#[napi(object)]
pub struct ShellCommand {
    pub parts: Vec<ShellPart>,
    pub tokens: Vec<String>,
    pub source: String,
}

#[napi(object)]
pub struct ShellAnalysis {
    pub commands: Vec<ShellCommand>,
}

fn node_text(node: tree_sitter::Node, bytes: &[u8]) -> String {
    node.utf8_text(bytes).unwrap_or("").to_string()
}

fn node_parts(node: tree_sitter::Node, bytes: &[u8]) -> Vec<ShellPart> {
    let mut out = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let kind = child.kind();
        if kind == "command_elements" {
            let mut inner = child.walk();
            for item in child.children(&mut inner) {
                let item_kind = item.kind();
                if item_kind == "command_argument_sep" || item_kind == "redirection" {
                    continue;
                }
                out.push(ShellPart {
                    kind: item_kind.to_string(),
                    text: node_text(item, bytes),
                });
            }
            continue;
        }
        if !matches!(
            kind,
            "command_name"
                | "command_name_expr"
                | "word"
                | "string"
                | "raw_string"
                | "concatenation"
        ) {
            continue;
        }
        out.push(ShellPart {
            kind: kind.to_string(),
            text: node_text(child, bytes),
        });
    }
    out
}

fn node_source(node: tree_sitter::Node, bytes: &[u8]) -> String {
    let target = match node.parent() {
        Some(parent) if parent.kind() == "redirected_statement" => parent,
        _ => node,
    };
    node_text(target, bytes).trim().to_string()
}

fn collect_commands(node: tree_sitter::Node, bytes: &[u8], out: &mut Vec<ShellCommand>) {
    if node.kind() == "command" {
        let parts = node_parts(node, bytes);
        let tokens = parts.iter().map(|part| part.text.clone()).collect();
        out.push(ShellCommand {
            parts,
            tokens,
            source: node_source(node, bytes),
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_commands(child, bytes, out);
    }
}

fn shell_analyze_impl(command: &str, dialect: &str) -> Result<ShellAnalysis, String> {
    let language: tree_sitter::Language = if dialect == "powershell" {
        tree_sitter_powershell::LANGUAGE.into()
    } else {
        tree_sitter_bash::LANGUAGE.into()
    };
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| format!("failed to set shell language: {error}"))?;
    let tree = parser
        .parse(command, None)
        .ok_or_else(|| "failed to parse shell command".to_string())?;
    let bytes = command.as_bytes();
    let mut commands = Vec::new();
    collect_commands(tree.root_node(), bytes, &mut commands);
    Ok(ShellAnalysis { commands })
}

/// Extract every shell command (parts/tokens/source) from a command string,
/// matching the TypeScript `shell/extract.ts` walk over the wasm parser.
#[napi(js_name = "shellAnalyze")]
pub fn shell_analyze(command: String, dialect: String) -> napi::Result<ShellAnalysis> {
    shell_analyze_impl(&command, &dialect).map_err(napi::Error::from_reason)
}

fn path_bufs(values: Vec<String>) -> Vec<std::path::PathBuf> {
    values.into_iter().map(std::path::PathBuf::from).collect()
}

/// Whether the host has a process-sandbox backend (macOS seatbelt or Linux Landlock).
#[napi(js_name = "sandboxSupported")]
pub fn sandbox_supported() -> bool {
    miao_sandbox::supported()
}

/// Build the macOS seatbelt profile the sandbox runner passes to `sandbox-exec`.
#[napi(js_name = "sandboxProfile")]
pub fn sandbox_profile(
    workdirs: Vec<String>,
    allow_paths: Vec<String>,
    allow_network: bool,
    compat: bool,
) -> String {
    miao_sandbox::profile(
        &path_bufs(workdirs),
        &path_bufs(allow_paths),
        allow_network,
        compat,
    )
}

/// Apply the platform sandbox to the current process. Linux restricts with
/// Landlock so spawned children inherit it; other platforms are a no-op.
#[napi(js_name = "sandboxRestrict")]
pub fn sandbox_restrict(
    workdirs: Vec<String>,
    allow_paths: Vec<String>,
    allow_network: bool,
) -> napi::Result<()> {
    miao_sandbox::apply_linux_restrictions(
        &path_bufs(workdirs),
        &path_bufs(allow_paths),
        allow_network,
    )
    .map_err(napi::Error::from_reason)
}

/// Windows: spawn the command inside the AppContainer sandbox and wait for it,
/// with stdio inherited so the child shares this process's console. Mirrors
/// `miao-run`: fall back to unsandboxed execution when the container cannot be
/// set up, and return 127 when a sandboxed spawn fails.
#[napi(js_name = "sandboxSpawn")]
pub fn sandbox_spawn(
    workdirs: Vec<String>,
    allow_paths: Vec<String>,
    allow_network: bool,
    command: Vec<String>,
) -> napi::Result<i32> {
    #[cfg(target_os = "windows")]
    {
        use miao_sandbox::win::WinError;
        return match miao_sandbox::win::run(
            &path_bufs(workdirs),
            &path_bufs(allow_paths),
            allow_network,
            &command,
        ) {
            Ok(code) => Ok(code),
            Err(WinError::Unavailable(message)) => {
                eprintln!("miao: windows sandbox unavailable: {message}");
                eprintln!("miao: running unsandboxed (no file/network isolation)");
                let code = std::process::Command::new(&command[0])
                    .args(&command[1..])
                    .status()
                    .ok()
                    .and_then(|status| status.code())
                    .unwrap_or(1);
                Ok(code)
            }
            Err(WinError::Start(message)) => {
                eprintln!("miao: failed to start command: {message}");
                Ok(127)
            }
        };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (workdirs, allow_paths, allow_network, command);
        Err(napi::Error::from_reason(
            "sandboxSpawn is only implemented on Windows",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(content: &str, old: &str, new: &str) -> String {
        replace(content, old, new, false).expect("edit should succeed")
    }

    #[test]
    fn rejects_identical_strings() {
        assert_eq!(
            replace("content", "same", "same", false),
            Err(EditError::Identical)
        );
    }

    #[test]
    fn rejects_empty_old_string() {
        assert_eq!(replace("content", "", "x", false), Err(EditError::EmptyOld));
    }

    #[test]
    fn replaces_simple_text() {
        assert_eq!(
            edit("old content here", "old content", "new content"),
            "new content here"
        );
    }

    #[test]
    fn replaces_first_visible_line_in_bom_file() {
        let content = "\u{feff}using System;\nclass Test {}\n";
        let result = edit(content, "using System;", "using Up;");
        assert_eq!(
            result.strip_prefix('\u{feff}'),
            Some("using Up;\nclass Test {}\n")
        );
    }

    #[test]
    fn replaces_all_occurrences() {
        let result = replace("foo bar foo baz foo", "foo", "qux", true).unwrap();
        assert_eq!(result, "qux bar qux baz qux");
    }

    #[test]
    fn handles_multiline_replacements() {
        let result = edit("line1\nline2\nline3", "line2", "new line 2\nextra line");
        assert_eq!(result, "line1\nnew line 2\nextra line\nline3");
    }

    #[test]
    fn handles_crlf_content() {
        let result = edit("line1\r\nold\r\nline3", "old", "new");
        assert_eq!(result, "line1\r\nnew\r\nline3");
    }

    #[test]
    fn reports_not_found() {
        assert_eq!(
            replace("actual content", "not in file", "replacement", false),
            Err(EditError::NotFound)
        );
    }

    #[test]
    fn fuzzy_matches_trimmed_indentation() {
        let content = "function configure() {\n    const enabled = true\n}\n";
        let old = "function configure() {\n  const enabled = true\n}";
        let result = replace(content, old, "REPLACED", false).unwrap();
        assert_eq!(result, "REPLACED\n");
    }

    #[test]
    fn rejects_loose_block_anchor_match() {
        let content = [
            "function configure() {",
            "  keepImportantState()",
            "  removeAllUserData()",
            "  archiveBackups()",
            "  auditLog()",
            "}",
        ]
        .join("\n");
        let old = ["function configure() {", "  const enabled = true", "}"].join("\n");
        assert_eq!(
            replace(&content, &old, "x", false),
            Err(EditError::NotFound)
        );
    }

    #[test]
    fn rejects_block_anchor_with_unrelated_middle() {
        let content = ["function configure() {", "  removeAllUserData()", "}"].join("\n");
        let old = ["function configure() {", "  const enabled = true", "}"].join("\n");
        assert_eq!(
            replace(&content, &old, "x", false),
            Err(EditError::NotFound)
        );
    }

    #[test]
    fn diff_stats_count_lines() {
        let (additions, deletions) = compute_stats(
            "line1\nline2\nline3",
            "line1\nnew line a\nnew line b\nline3",
        );
        assert_eq!((additions, deletions), (2, 1));
    }

    fn chunk(old: &[&str], new: &[&str]) -> PatchChunk {
        PatchChunk {
            old_lines: old.iter().map(|line| line.to_string()).collect(),
            new_lines: new.iter().map(|line| line.to_string()).collect(),
            change_context: None,
            is_end_of_file: None,
        }
    }

    #[test]
    fn derive_replaces_exact_lines() {
        let result = derive_new_contents(
            &[chunk(&["line2"], &["CHANGED"])],
            "f.txt",
            "line1\nline2\nline3\n",
        )
        .unwrap();
        assert_eq!(result.content, "line1\nCHANGED\nline3\n");
    }

    #[test]
    fn derive_inserts_when_old_lines_empty() {
        let result =
            derive_new_contents(&[chunk(&[], &["inserted"])], "f.txt", "line1\nline2\n").unwrap();
        assert_eq!(result.content, "line1\nline2\ninserted\n");
    }

    #[test]
    fn derive_matches_with_trimmed_whitespace() {
        let result = derive_new_contents(
            &[chunk(&["  line2  "], &["CHANGED"])],
            "f.txt",
            "line1\nline2\nline3\n",
        )
        .unwrap();
        assert_eq!(result.content, "line1\nCHANGED\nline3\n");
    }

    #[test]
    fn derive_matches_normalized_unicode() {
        let result = derive_new_contents(
            &[chunk(&["const x = \u{201c}a\u{201d}"], &["const x = 1"])],
            "f.txt",
            "const x = \"a\"\n",
        )
        .unwrap();
        assert_eq!(result.content, "const x = 1\n");
    }

    #[test]
    fn derive_reports_missing_lines() {
        let result = derive_new_contents(&[chunk(&["missing"], &["x"])], "f.txt", "line1\nline2\n");
        assert_eq!(
            result.unwrap_err(),
            "Failed to find expected lines in f.txt:\nmissing"
        );
    }

    fn git(args: &[&str], cwd: &std::path::Path) -> std::process::Output {
        std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .expect("git available")
    }

    fn temp_repo(name: &str) -> Option<std::path::PathBuf> {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return None;
        }
        let dir = std::env::temp_dir().join(format!("miao-native-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&["init", "-q"], &dir);
        std::fs::write(dir.join("file.txt"), "hello\nworld\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "remove me\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2, 255, 254]).unwrap();
        git(&["add", "-A"], &dir);
        git(&["commit", "-qm", "init"], &dir);
        Some(dir)
    }

    #[test]
    fn rev_parse_matches_git() {
        let Some(dir) = temp_repo("revparse") else {
            return;
        };
        let expected = String::from_utf8(git(&["rev-parse", "HEAD"], &dir).stdout)
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(
            git_rev_parse_impl(dir.to_str().unwrap(), "HEAD").unwrap(),
            expected
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blob_matches_git_show() {
        let Some(dir) = temp_repo("blob") else { return };
        let expected = String::from_utf8(git(&["show", "HEAD:file.txt"], &dir).stdout).unwrap();
        let blob = git_blob_impl(dir.to_str().unwrap(), "HEAD", "file.txt").unwrap();
        assert!(!blob.binary);
        assert_eq!(blob.content, expected);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rev_parse_errors_outside_repository() {
        assert!(git_rev_parse_impl("/", "HEAD").is_err());
    }

    #[test]
    fn worktree_changes_match_git_diff() {
        let Some(dir) = temp_repo("wtchanges") else {
            return;
        };
        std::fs::write(dir.join("file.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();
        let expected = String::from_utf8(git(&["diff", "--name-only"], &dir).stdout).unwrap();
        let mut expected: Vec<String> = expected
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect();
        expected.sort();
        assert_eq!(
            git_worktree_changes_impl(dir.to_str().unwrap()).unwrap(),
            expected
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_base_matches_git() {
        let Some(dir) = temp_repo("mergebase") else {
            return;
        };
        git(&["checkout", "-qb", "feature"], &dir);
        std::fs::write(dir.join("feature.txt"), "x\n").unwrap();
        git(&["add", "-A"], &dir);
        git(&["commit", "-qm", "feature"], &dir);
        git(&["checkout", "-q", "-"], &dir);
        let expected = String::from_utf8(git(&["merge-base", "HEAD", "feature"], &dir).stdout)
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(
            git_merge_base_impl(dir.to_str().unwrap(), "HEAD", "feature").unwrap(),
            expected
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_line_endings() {
        assert_eq!(detect_line_ending("a\r\nb".to_string()), "crlf");
        assert_eq!(detect_line_ending("a\nb".to_string()), "lf");
        assert_eq!(detect_line_ending("a\rb".to_string()), "cr");
        assert_eq!(detect_line_ending("abc".to_string()), "none");
    }

    #[test]
    fn normalizes_line_endings() {
        assert_eq!(
            normalize_line_endings("a\r\nb\rc\nd".to_string(), "lf".to_string()),
            "a\nb\nc\nd"
        );
        assert_eq!(
            normalize_line_endings("a\nb".to_string(), "crlf".to_string()),
            "a\r\nb"
        );
    }

    #[test]
    fn counts_tokens() {
        assert_eq!(count_tokens(String::new(), None), 0);
        assert!(count_tokens("hello world".to_string(), None) >= 2);
        assert!(count_tokens("hello world".to_string(), Some("cl100k_base".to_string())) >= 2);
    }

    #[test]
    fn walks_files() {
        let dir = std::env::temp_dir().join(format!("miao-native-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "").unwrap();
        std::fs::write(dir.join("sub/b.txt"), "").unwrap();
        std::fs::write(dir.join(".hidden"), "").unwrap();

        let root = dir.to_str().unwrap();
        assert_eq!(
            walk_files_impl(root, false, false).unwrap(),
            vec!["a.txt", "sub/b.txt"]
        );
        assert!(walk_files_impl(root, true, false)
            .unwrap()
            .contains(&".hidden".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hashes_match_known_vectors() {
        assert_eq!(
            sha256_hex(String::new()),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            blake3_hex(String::new()),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }

    #[test]
    fn diff_round_trips_through_git_apply() {
        let Some(dir) = temp_repo("diff") else { return };
        std::fs::write(dir.join("file.txt"), "hello\nCHANGED\n").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();

        let patch = git_diff_impl(dir.to_str().unwrap()).unwrap();
        assert!(patch.contains("diff --git a/file.txt b/file.txt"));
        assert!(patch.contains("deleted file mode 100644"));

        git(&["checkout", "--", "."], &dir);
        let patch_file = dir.join("native.diff");
        std::fs::write(&patch_file, &patch).unwrap();
        let applied = git(&["apply", patch_file.to_str().unwrap()], &dir);
        assert!(
            applied.status.success(),
            "git apply failed: {}",
            String::from_utf8_lossy(&applied.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("file.txt")).unwrap(),
            "hello\nCHANGED\n"
        );
        assert!(!dir.join("gone.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn analyzes_bash_commands() {
        let analysis = shell_analyze_impl("cd /tmp && rm -rf foo/bar && echo hi", "bash").unwrap();
        let tokens: Vec<Vec<String>> = analysis
            .commands
            .iter()
            .map(|item| item.tokens.clone())
            .collect();
        assert_eq!(tokens[0], vec!["cd", "/tmp"]);
        assert!(tokens
            .iter()
            .any(|item| item.first().map(String::as_str) == Some("rm")));
        assert!(tokens
            .iter()
            .any(|item| item.first().map(String::as_str) == Some("echo")
                && item.get(1).map(String::as_str) == Some("hi")));
    }

    #[test]
    fn widens_redirected_command_source() {
        let analysis = shell_analyze_impl("echo hi > out.txt", "bash").unwrap();
        assert_eq!(analysis.commands.len(), 1);
        assert_eq!(analysis.commands[0].tokens, vec!["echo", "hi"]);
        assert_eq!(analysis.commands[0].source, "echo hi > out.txt");
    }
}
