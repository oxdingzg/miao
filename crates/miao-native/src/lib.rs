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
        let lines_to_check = std::cmp::min(search_block.saturating_sub(2), actual_block.saturating_sub(2));
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
                let pattern = words.iter().map(|word| regex::escape(word)).collect::<Vec<_>>().join(r"\s+");
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
        let non_empty: Vec<&&str> = lines.iter().filter(|line| !line.trim().is_empty()).collect();
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
            .map(|line| if line.trim().is_empty() { (*line).to_string() } else { line[min_indent.min(line.len())..].to_string() })
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
        > std::cmp::max(old_string.trim().chars().count() + 500, old_string.trim().chars().count() * 4)
}

/// Pure port of `replace()` in `packages/miao/src/tool/edit.ts`.
pub fn replace(content: &str, old_string: &str, new_string: &str, replace_all: bool) -> Result<String, EditError> {
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
    replace(&content, &old_string, &new_string, replace_all.unwrap_or(false))
        .map_err(|error| napi::Error::from_reason(error.message()))
}

#[napi(js_name = "applyEdit")]
pub fn apply_edit(
    content: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> napi::Result<ApplyEditResult> {
    let result = replace(&content, &old_string, &new_string, replace_all.unwrap_or(false))
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
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => out.push('-'),
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
        if from_end >= start && pattern.iter().enumerate().all(|(j, p)| compare(lines[from_end + j], p)) {
            return from_end as i64;
        }
    }
    if pattern.len() > lines.len() {
        return -1;
    }
    for i in start..=(lines.len() - pattern.len()) {
        if pattern.iter().enumerate().all(|(j, p)| compare(lines[i + j], p)) {
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
    let rstrip = try_match(lines, pattern, start, eof, |a, b| a.trim_end() == b.trim_end());
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

fn derive_new_contents(chunks: &[PatchChunk], file_path: &str, original_text: &str) -> Result<DeriveResult, String> {
    let (original_bom, text) = split_bom(original_text);
    let mut original_lines: Vec<&str> = text.split('\n').collect();
    if original_lines.last().map(|line| line.is_empty()).unwrap_or(false) {
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
            Some(Summary::Modified) | Some(Summary::TypeChange) | Some(Summary::Conflict) => "modified",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(content: &str, old: &str, new: &str) -> String {
        replace(content, old, new, false).expect("edit should succeed")
    }

    #[test]
    fn rejects_identical_strings() {
        assert_eq!(replace("content", "same", "same", false), Err(EditError::Identical));
    }

    #[test]
    fn rejects_empty_old_string() {
        assert_eq!(replace("content", "", "x", false), Err(EditError::EmptyOld));
    }

    #[test]
    fn replaces_simple_text() {
        assert_eq!(edit("old content here", "old content", "new content"), "new content here");
    }

    #[test]
    fn replaces_first_visible_line_in_bom_file() {
        let content = "\u{feff}using System;\nclass Test {}\n";
        let result = edit(content, "using System;", "using Up;");
        assert_eq!(result.strip_prefix('\u{feff}'), Some("using Up;\nclass Test {}\n"));
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
        assert_eq!(replace("actual content", "not in file", "replacement", false), Err(EditError::NotFound));
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
        assert_eq!(replace(&content, &old, "x", false), Err(EditError::NotFound));
    }

    #[test]
    fn rejects_block_anchor_with_unrelated_middle() {
        let content = ["function configure() {", "  removeAllUserData()", "}"].join("\n");
        let old = ["function configure() {", "  const enabled = true", "}"].join("\n");
        assert_eq!(replace(&content, &old, "x", false), Err(EditError::NotFound));
    }

    #[test]
    fn diff_stats_count_lines() {
        let (additions, deletions) = compute_stats("line1\nline2\nline3", "line1\nnew line a\nnew line b\nline3");
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
        let result = derive_new_contents(&[chunk(&["line2"], &["CHANGED"])], "f.txt", "line1\nline2\nline3\n").unwrap();
        assert_eq!(result.content, "line1\nCHANGED\nline3\n");
    }

    #[test]
    fn derive_inserts_when_old_lines_empty() {
        let result = derive_new_contents(&[chunk(&[], &["inserted"])], "f.txt", "line1\nline2\n").unwrap();
        assert_eq!(result.content, "line1\nline2\ninserted\n");
    }

    #[test]
    fn derive_matches_with_trimmed_whitespace() {
        let result = derive_new_contents(&[chunk(&["  line2  "], &["CHANGED"])], "f.txt", "line1\nline2\nline3\n").unwrap();
        assert_eq!(result.content, "line1\nCHANGED\nline3\n");
    }

    #[test]
    fn derive_matches_normalized_unicode() {
        let result =
            derive_new_contents(&[chunk(&["const x = \u{201c}a\u{201d}"], &["const x = 1"])], "f.txt", "const x = \"a\"\n").unwrap();
        assert_eq!(result.content, "const x = 1\n");
    }

    #[test]
    fn derive_reports_missing_lines() {
        let result = derive_new_contents(&[chunk(&["missing"], &["x"])], "f.txt", "line1\nline2\n");
        assert_eq!(result.unwrap_err(), "Failed to find expected lines in f.txt:\nmissing");
    }
}
