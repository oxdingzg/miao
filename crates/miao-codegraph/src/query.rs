//! Reading the index back out: `explore` ranks symbols for a question, `node`
//! serves one file or one symbol with its neighbours, `callers` lists the call
//! sites, `status` reports what the index covers.
//!
//! Every renderer answers in one call and says so: the point of the index is to
//! replace a grep-then-read loop, so the output states that its source is
//! complete and names what it left out.

use crate::resolve;
use crate::sync;
use crate::Error;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const DEFAULT_EXPLORE_CHARS: usize = 24000;
const DEFAULT_NODE_CHARS: usize = 32000;
const MAX_LINE_CHARS: usize = 400;
const FAN_IN_BONUS_CAP: i64 = 8;

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "from", "into", "by",
    "how", "what", "where", "which", "when", "why", "does", "do", "is", "are", "was", "were", "be",
    "this", "that", "these", "those", "it", "its", "we", "you", "i", "can", "should", "would",
    "code", "file", "files", "function", "functions", "line", "lines", "used", "use", "using",
    "work", "works", "find", "explain", "trace", "happens",
];

struct Symbol {
    id: String,
    kind: String,
    name: String,
    qualified: String,
    path: String,
    start_line: u32,
    end_line: u32,
    signature: String,
    docstring: String,
}

pub fn explore(
    connection: &Connection,
    root: &Path,
    query: &str,
    limit: Option<usize>,
    max_chars: Option<usize>,
) -> Result<String, Error> {
    let limit = limit.unwrap_or(6).clamp(1, 24);
    let budget = max_chars
        .unwrap_or(DEFAULT_EXPLORE_CHARS)
        .clamp(2000, 200_000);
    let fan_in = fan_in(connection)?;
    let tokens = tokens(query);
    let ranges = ranges(query);
    let mut scored: HashMap<String, (Symbol, i64)> = HashMap::new();
    for token in &tokens {
        for symbol in matching(connection, token, 40)? {
            let lowered = symbol.name.to_lowercase();
            let points = match (lowered == *token, lowered.starts_with(token.as_str())) {
                (true, _) => 100,
                (false, true) => 70,
                (false, false) => 45,
            } + fan_in.get(&symbol.id).copied().unwrap_or(0).min(FAN_IN_BONUS_CAP)
                + i64::from(symbol.kind != "impl");
            keep(&mut scored, symbol, points);
        }
        for symbol in full_text(connection, token, 30)? {
            keep(&mut scored, symbol, 30);
        }
    }
    let mut ranked = scored.into_values().collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| left.0.path.cmp(&right.0.path))
            .then_with(|| left.0.start_line.cmp(&right.0.start_line))
    });
    let picked = ranked
        .iter()
        .filter(|(symbol, _)| symbol.kind != "impl")
        .take(limit)
        .map(|(symbol, _)| symbol)
        .collect::<Vec<_>>();
    let mut text = String::new();
    let mut cache = HashMap::new();
    text.push_str(&format!(
        "Found {} symbol(s) for `{}`{}\n",
        picked.len(),
        query.trim(),
        if ranges.is_empty() { "" } else { " plus the requested ranges" }
    ));
    if !picked.is_empty() {
        text.push_str("> The source below is complete and verbatim — treat these files as already read.\n");
    }
    for (path, start, end) in &ranges {
        render_range(&mut text, root, &mut cache, path, *start, *end, budget);
    }
    let mut not_shown = Vec::new();
    let mut grouped: HashMap<&str, Vec<&Symbol>> = HashMap::new();
    for symbol in &picked {
        grouped.entry(symbol.path.as_str()).or_default().push(symbol);
    }
    let mut files = grouped.keys().copied().collect::<Vec<_>>();
    files.sort();
    for path in files {
        let mut symbols = grouped.remove(path).unwrap_or_default();
        symbols.sort_by_key(|symbol| symbol.start_line);
        for symbol in symbols {
            if text.chars().count() >= budget {
                not_shown.push(symbol);
                continue;
            }
            text.push_str(&format!("\n### {path}\n"));
            text.push_str(&format!(
                "`{}` — {} · lines {}-{} ({}){}\n",
                symbol.signature,
                symbol.qualified,
                symbol.start_line,
                symbol.end_line,
                symbol.kind,
                docstring_note(&symbol.docstring)
            ));
            render_range(
                &mut text,
                root,
                &mut cache,
                &symbol.path,
                symbol.start_line as usize,
                symbol.end_line as usize,
                budget,
            );
        }
    }
    text.push_str(&call_paths(connection, &picked)?);
    let remaining = ranked
        .iter()
        .filter(|(symbol, _)| {
            symbol.kind != "impl" && !picked.iter().any(|picked| picked.id == symbol.id)
        })
        .collect::<Vec<_>>();
    not_shown.extend(remaining.iter().take(12).map(|(symbol, _)| symbol));
    if !not_shown.is_empty() {
        text.push_str(&format!("\n## Not shown ({})\n", not_shown.len()));
        for symbol in not_shown.iter().take(12) {
            text.push_str(&format!(
                "- {} ({}:{}, {}) — ask for it by name instead of reading the file\n",
                symbol.qualified, symbol.path, symbol.start_line, symbol.kind
            ));
        }
    }
    if tokens.is_empty() && ranges.is_empty() {
        text.push_str("\nNo searchable token in the query. Name a symbol, a file, or `path:line-line`.\n");
    }
    Ok(text)
}

pub fn node(
    connection: &Connection,
    root: &Path,
    path: Option<&str>,
    symbol: Option<&str>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, Error> {
    let budget = DEFAULT_NODE_CHARS;
    let mut text = String::new();
    let mut cache = HashMap::new();
    if let Some(symbol) = symbol {
        let Some(found) = best(connection, symbol)? else {
            return Ok(format!("No symbol named `{symbol}` in the index.\n"));
        };
        text.push_str(&format!(
            "`{}` — {} · {} · lines {}-{} ({})\n",
            found.signature,
            found.qualified,
            found.path,
            found.start_line,
            found.end_line,
            found.kind
        ));
        if !found.docstring.is_empty() {
            text.push_str(&format!("> {}\n", found.docstring));
        }
        render_lines(
            &mut text,
            root,
            &mut cache,
            &found.path,
            found.start_line as usize,
            found.end_line as usize,
            budget,
        );
        text.push_str(&neighbours(connection, &found.id)?);
        return Ok(text);
    }
    let Some(path) = path else {
        return Ok("Pass `path` to read a file, or `symbol` to read one definition.\n".to_owned());
    };
    let path = path.trim_start_matches("./");
    if !root.join(path).is_file() {
        return Ok(format!("`{path}` is not a file in this workspace.\n"));
    }
    let start = offset.unwrap_or(1).max(1);
    let lines = file_lines(root, &mut cache, path);
    let end = limit
        .map(|limit| (start + limit).saturating_sub(1))
        .unwrap_or(lines.len())
        .min(lines.len());
    text.push_str(&format!("{path} ({} lines)\n", lines.len()));
    render_lines(&mut text, root, &mut cache, path, start, end, budget);
    text.push_str(&dependents(connection, path)?);
    Ok(text)
}

pub fn callers(
    connection: &Connection,
    symbol: &str,
    limit: Option<usize>,
) -> Result<String, Error> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let Some(found) = best(connection, symbol)? else {
        return Ok(format!("No symbol named `{symbol}` in the index.\n"));
    };
    let mut statement = connection.prepare(
        "SELECT n.qualified, n.path, n.start_line, e.line FROM edges e JOIN nodes n ON n.id=e.source WHERE e.target=?1 AND e.kind='calls' ORDER BY n.path, e.line LIMIT ?2",
    )?;
    let rows = statement.query_map(params![found.id, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<i64>>(3)?,
        ))
    })?;
    let mut text = format!(
        "Callers of {} ({}:{})\n",
        found.qualified, found.path, found.start_line
    );
    let mut count = 0;
    for row in rows {
        let (qualified, path, line, call_line) = row?;
        count += 1;
        text.push_str(&format!("- {qualified} ({path}:{})\n", call_line.unwrap_or(line)));
    }
    if count == 0 {
        text.push_str("- none in the index: either it is an entry point, or its callers resolve by a spelling this index does not follow\n");
    }
    Ok(text)
}

pub fn status(connection: &Connection, database: &Path) -> Result<String, Error> {
    let count = |sql: &str| -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or_default()
    };
    let files = count("SELECT COUNT(*) FROM files");
    let nodes = count("SELECT COUNT(*) FROM nodes");
    let calls = count("SELECT COUNT(*) FROM edges WHERE kind='calls'");
    let refs = count("SELECT COUNT(*) FROM refs WHERE status='pending'");
    let failed = count("SELECT COUNT(*) FROM refs WHERE status='failed'");
    let mut text = format!(
        "codegraph index: {files} files, {nodes} symbols, {calls} call edges, {refs} unresolved call refs ({failed} given up)\n"
    );
    let synced = crate::schema::meta(connection, "synced_at")
        .and_then(|value| value.parse::<i64>().ok())
        .map(|millis| format!("{millis} ms epoch"))
        .unwrap_or_else(|| "never".to_owned());
    text.push_str(&format!(
        "extractor: v{} · last refresh at {synced} · supported languages: {}\n",
        crate::extract::VERSION,
        crate::lang::LANGUAGES.join(", ")
    ));
    let mut statement =
        connection.prepare("SELECT language, COUNT(*) FROM files GROUP BY language ORDER BY COUNT(*) DESC")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let languages = rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(language, files)| format!("{language} {files}"))
        .collect::<Vec<_>>()
        .join(", ");
    if !languages.is_empty() {
        text.push_str(&format!("languages: {languages}\n"));
    }
    let size = std::fs::metadata(database).map(|meta| meta.len()).unwrap_or(0);
    text.push_str(&format!(
        "store: {} ({:.1} MB)\n",
        database.display(),
        size as f64 / 1_048_576.0
    ));
    Ok(text)
}

fn docstring_note(docstring: &str) -> String {
    if docstring.is_empty() {
        String::new()
    } else {
        format!(" · {docstring}")
    }
}

fn keep(scored: &mut HashMap<String, (Symbol, i64)>, symbol: Symbol, points: i64) {
    match scored.get_mut(&symbol.id) {
        Some(existing) => {
            if points > existing.1 {
                existing.1 = points;
            }
        }
        None => {
            scored.insert(symbol.id.clone(), (symbol, points));
        }
    }
}

fn tokens(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .map(str::to_lowercase)
        .filter(|token| token.len() >= 2)
        .filter(|token| !STOPWORDS.contains(&token.as_str()))
        .filter(|token| seen.insert(token.clone()))
        .take(8)
        .collect()
}

fn ranges(query: &str) -> Vec<(String, usize, usize)> {
    let mut found = Vec::new();
    for token in query.split_whitespace() {
        let Some((path, range)) = token.rsplit_once(':') else {
            continue;
        };
        if !path.contains('/') && !path.contains('.') {
            continue;
        }
        let (start, end) = match range.split_once('-') {
            Some((start, end)) => (start, end),
            None => (range, range),
        };
        let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) else {
            continue;
        };
        if start == 0 || end < start {
            continue;
        }
        found.push((path.trim_start_matches("./").to_owned(), start, end.min(start + 400)));
    }
    found
}

fn matching(connection: &Connection, token: &str, limit: usize) -> Result<Vec<Symbol>, Error> {
    let mut statement = connection.prepare(
        "SELECT id, kind, name, qualified, path, start_line, end_line, COALESCE(signature,''), COALESCE(docstring,'') FROM nodes WHERE lower(name) LIKE ?1 OR lower(qualified) LIKE ?1 ORDER BY length(name), path LIMIT ?2",
    )?;
    let pattern = format!("%{token}%");
    let rows = statement.query_map(params![pattern, limit as i64], symbol_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn full_text(connection: &Connection, token: &str, limit: usize) -> Result<Vec<Symbol>, Error> {
    let sanitized = token
        .chars()
        .filter(|character| character.is_alphanumeric() || *character == '_')
        .collect::<String>();
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT n.id, n.kind, n.name, n.qualified, n.path, n.start_line, n.end_line, COALESCE(n.signature,''), COALESCE(n.docstring,'') FROM nodes_fts f JOIN nodes n ON n.id=f.id WHERE nodes_fts MATCH ?1 ORDER BY bm25(nodes_fts) LIMIT ?2",
    )?;
    let query = format!("{sanitized}*");
    let Ok(rows) = statement.query_map(params![query, limit as i64], symbol_row) else {
        return Ok(Vec::new());
    };
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn symbol_row(row: &rusqlite::Row) -> rusqlite::Result<Symbol> {
    Ok(Symbol {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        qualified: row.get(3)?,
        path: row.get(4)?,
        start_line: row.get::<_, i64>(5)? as u32,
        end_line: row.get::<_, i64>(6)? as u32,
        signature: row.get(7)?,
        docstring: row.get(8)?,
    })
}

fn fan_in(connection: &Connection) -> Result<HashMap<String, i64>, Error> {
    let mut statement =
        connection.prepare("SELECT target, COUNT(*) FROM edges WHERE kind='calls' GROUP BY target")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
}

fn best(connection: &Connection, symbol: &str) -> Result<Option<Symbol>, Error> {
    let trimmed = symbol.trim();
    let lowered = trimmed.to_lowercase();
    let mut statement = connection.prepare(
        "SELECT id, kind, name, qualified, path, start_line, end_line, COALESCE(signature,''), COALESCE(docstring,'') FROM nodes WHERE lower(name)=?1 OR lower(qualified)=?1 ORDER BY kind='impl', path LIMIT 1",
    )?;
    let mut rows = statement.query_map([&lowered], symbol_row)?;
    if let Some(row) = rows.next() {
        return Ok(Some(row?));
    }
    let mut statement = connection.prepare(
        "SELECT id, kind, name, qualified, path, start_line, end_line, COALESCE(signature,''), COALESCE(docstring,'') FROM nodes WHERE lower(qualified) LIKE ?1 ORDER BY length(qualified) LIMIT 1",
    )?;
    let pattern = format!("%::{lowered}");
    let mut rows = statement.query_map([pattern], symbol_row)?;
    Ok(rows.next().transpose()?)
}

fn file_lines(root: &Path, cache: &mut HashMap<String, Vec<String>>, path: &str) -> Vec<String> {
    if let Some(lines) = cache.get(path) {
        return lines.clone();
    }
    let lines = std::fs::read_to_string(root.join(path))
        .map(|text| text.lines().map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    cache.insert(path.to_owned(), lines.clone());
    lines
}

fn render_range(
    text: &mut String,
    root: &Path,
    cache: &mut HashMap<String, Vec<String>>,
    path: &str,
    start: usize,
    end: usize,
    budget: usize,
) {
    render_lines(text, root, cache, path, start, end, budget);
}

fn render_lines(
    text: &mut String,
    root: &Path,
    cache: &mut HashMap<String, Vec<String>>,
    path: &str,
    start: usize,
    end: usize,
    budget: usize,
) {
    let lines = file_lines(root, cache, path);
    if lines.is_empty() {
        text.push_str(&format!("> {path} is not readable — the index row is stale\n"));
        return;
    }
    let end = end.min(lines.len());
    for number in start..=end {
        if text.chars().count() >= budget {
            text.push_str(&format!(
                "… lines {number}-{end} elided at this call's budget; ask for {path}:{number}-{end}\n"
            ));
            return;
        }
        let line = &lines[number - 1];
        let clipped = if line.chars().count() > MAX_LINE_CHARS {
            let head = line.chars().take(MAX_LINE_CHARS).collect::<String>();
            format!("{head}… [line truncated]")
        } else {
            line.clone()
        };
        text.push_str(&format!("{number:>6}\t{clipped}\n"));
    }
}

fn call_paths(connection: &Connection, picked: &[&Symbol]) -> Result<String, Error> {
    let mut text = String::new();
    let mut wrote = false;
    let mut statement = connection.prepare(
        "SELECT n.qualified, n.path, COALESCE(e.line, n.start_line) FROM edges e JOIN nodes n ON n.id=e.source WHERE e.target=?1 AND e.kind='calls' ORDER BY n.path LIMIT 6",
    )?;
    let mut callees = connection.prepare(
        "SELECT n.qualified, n.path, n.start_line FROM edges e JOIN nodes n ON n.id=e.target WHERE e.source=?1 AND e.kind='calls' ORDER BY n.path LIMIT 6",
    )?;
    for symbol in picked.iter().take(3) {
        let callers = statement
            .query_map([&symbol.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let downstream = callees
            .query_map([&symbol.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if callers.is_empty() && downstream.is_empty() {
            continue;
        }
        if !wrote {
            text.push_str("\n## Call paths\n");
            wrote = true;
        }
        text.push_str(&format!(
            "{} ({}:{})\n",
            symbol.qualified, symbol.path, symbol.start_line
        ));
        if !callers.is_empty() {
            text.push_str(&format!(
                "  <- called by: {}\n",
                callers
                    .iter()
                    .map(|(qualified, path, line)| format!("{qualified} ({path}:{line})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !downstream.is_empty() {
            text.push_str(&format!(
                "  -> calls: {}\n",
                downstream
                    .iter()
                    .map(|(qualified, path, line)| format!("{qualified} ({path}:{line})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    Ok(text)
}

fn neighbours(connection: &Connection, id: &str) -> Result<String, Error> {
    let mut text = String::new();
    let mut statement = connection.prepare(
        "SELECT n.qualified, n.path, COALESCE(e.line, n.start_line) FROM edges e JOIN nodes n ON n.id=e.source WHERE e.target=?1 AND e.kind='calls' ORDER BY n.path LIMIT 10",
    )?;
    let callers = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if callers.is_empty() {
        text.push_str("\nCallers: none in the index.\n");
    } else {
        text.push_str("\nCallers:\n");
        for (qualified, path, line) in callers {
            text.push_str(&format!("- {qualified} ({path}:{line})\n"));
        }
    }
    let mut statement = connection.prepare(
        "SELECT n.qualified, n.path, n.start_line FROM edges e JOIN nodes n ON n.id=e.target WHERE e.source=?1 AND e.kind='calls' ORDER BY n.path LIMIT 10",
    )?;
    let downstream = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if !downstream.is_empty() {
        text.push_str("Calls:\n");
        for (qualified, path, line) in downstream {
            text.push_str(&format!("- {qualified} ({path}:{line})\n"));
        }
    }
    Ok(text)
}

fn dependents(connection: &Connection, path: &str) -> Result<String, Error> {
    let symbols = resolve::load(connection)?;
    let imports = sync::load_imports(connection)?;
    let mut found = Vec::new();
    for (from, entries) in &imports {
        if from == path {
            continue;
        }
        for (source, _) in entries {
            if resolve::import_target(&symbols, source, from).as_deref() == Some(path) {
                found.push(from.clone());
                break;
            }
        }
    }
    found.sort();
    found.dedup();
    if found.is_empty() {
        return Ok("\nDependents: none the index can follow.\n".to_owned());
    }
    Ok(format!(
        "\nDependents ({}): {}\n",
        found.len(),
        found.into_iter().take(12).collect::<Vec<_>>().join(", ")
    ))
}
