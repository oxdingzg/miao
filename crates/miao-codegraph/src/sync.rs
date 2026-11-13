//! Index maintenance: walk the workspace, re-extract the files whose size or
//! mtime moved, then resolve the call references that arrived with them.
//!
//! Work is bounded so a tool call answers inside a turn: a run stops at its
//! budget and reports what is left, and the next run continues from there.

use crate::{extract, lang, resolve, schema, Error};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const MAX_FILES: usize = 20000;
const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_DEPTH: usize = 24;
const MAX_REFS: usize = 20000;

/// Directories that never hold first-party source. Generated trees are skipped
/// by name rather than by `.gitignore`, because reading ignore files per
/// directory costs more than the few extra walks it saves.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".miao",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "Pods",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    "coverage",
    "test-results",
];

#[derive(Clone, Copy)]
pub struct Budget {
    pub files: usize,
    pub millis: u128,
    pub refs: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            files: 1500,
            millis: 4000,
            refs: MAX_REFS,
        }
    }
}

pub struct Report {
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub pending: usize,
    pub millis: u128,
    pub complete: bool,
    pub files: usize,
    pub nodes: usize,
    pub unresolved: usize,
}

struct Candidate {
    relative: String,
    size: u64,
    mtime: i64,
}

pub fn sync(connection: &mut Connection, root: &Path, budget: Budget) -> Result<Report, Error> {
    let started = Instant::now();
    let (candidates, complete) = walk(root);
    let seen: HashSet<String> = candidates.iter().map(|item| item.relative.clone()).collect();
    let (mut indexed, mut unchanged, mut pending) = (0, 0, 0);
    for candidate in &candidates {
        if indexed >= budget.files || started.elapsed().as_millis() >= budget.millis {
            pending += 1;
            continue;
        }
        let known: Option<(i64, i64)> = connection
            .query_row(
                "SELECT size, mtime FROM files WHERE path=?1",
                [&candidate.relative],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if known == Some((candidate.size as i64, candidate.mtime)) {
            unchanged += 1;
            continue;
        }
        index_file(connection, root, candidate)?;
        indexed += 1;
    }
    let removed = prune(connection, &seen, complete)?;
    let unresolved = resolve::run(connection, budget.refs)?;
    schema::set_meta(connection, "synced_at", &now_ms().to_string())?;
    let files: i64 = connection.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
    let nodes: i64 = connection.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;
    Ok(Report {
        indexed,
        unchanged,
        removed,
        pending,
        millis: started.elapsed().as_millis(),
        complete,
        files: files as usize,
        nodes: nodes as usize,
        unresolved,
    })
}

/// Drop rows for files that are gone. A capped walk cannot prove absence, so it
/// never prunes: a truncated scan must not delete a repository.
fn prune(connection: &Connection, seen: &HashSet<String>, complete: bool) -> Result<usize, Error> {
    if !complete {
        return Ok(0);
    }
    let known = known_paths(connection)?;
    let mut removed = 0;
    for path in known.into_iter().filter(|path| !seen.contains(path)) {
        forget(connection, &path)?;
        connection.execute("DELETE FROM files WHERE path=?1", [&path])?;
        removed += 1;
    }
    Ok(removed)
}

pub fn known_paths(connection: &Connection) -> Result<Vec<String>, Error> {
    let mut statement = connection.prepare("SELECT path FROM files")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn forget(connection: &Connection, path: &str) -> Result<(), Error> {
    connection.execute(
        "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE path=?1) OR target IN (SELECT id FROM nodes WHERE path=?1)",
        [path],
    )?;
    connection.execute(
        "DELETE FROM nodes_fts WHERE id IN (SELECT id FROM nodes WHERE path=?1)",
        [path],
    )?;
    connection.execute("DELETE FROM refs WHERE path=?1", [path])?;
    connection.execute("DELETE FROM imports WHERE path=?1", [path])?;
    connection.execute("DELETE FROM nodes WHERE path=?1", [path])?;
    Ok(())
}

fn index_file(
    connection: &mut Connection,
    root: &Path,
    candidate: &Candidate,
) -> Result<(), Error> {
    let bytes = std::fs::read(root.join(&candidate.relative))?;
    let language = lang::detect(&candidate.relative).unwrap_or("unknown");
    let extracted = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| extract::extract(&candidate.relative, text));
    let digest = crate::digest(&bytes);
    let transaction = connection.transaction()?;
    forget(&transaction, &candidate.relative)?;
    let mut count = 0;
    if let Some(extracted) = &extracted {
        for (index, def) in extracted.defs.iter().enumerate() {
            let qualified = extracted.qualified(index);
            let id = format!("{}:{}:{}", def.kind, candidate.relative, qualified);
            let container = def.container.map(|container| {
                format!(
                    "{}:{}:{}",
                    extracted.defs[container].kind,
                    candidate.relative,
                    extracted.qualified(container)
                )
            });
            transaction.execute(
                "INSERT OR REPLACE INTO nodes(id,kind,name,qualified,path,language,start_line,end_line,start_col,end_col,signature,docstring,container,exported) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    id,
                    def.kind,
                    def.name,
                    qualified,
                    candidate.relative,
                    language,
                    def.start_line,
                    def.end_line,
                    def.start_col,
                    def.end_col,
                    def.signature,
                    def.docstring,
                    container,
                    def.exported as i64
                ],
            )?;
            transaction.execute(
                "INSERT INTO nodes_fts(id,name,qualified,signature,docstring) VALUES(?1,?2,?3,?4,?5)",
                params![
                    id,
                    def.name,
                    qualified,
                    def.signature,
                    def.docstring.as_deref().unwrap_or_default()
                ],
            )?;
            if let Some(container) = container {
                transaction.execute(
                    "INSERT INTO edges(source,target,kind,line,provenance) VALUES(?1,?2,'contains',?3,'extract')",
                    params![container, id, def.start_line],
                )?;
            }
            count += 1;
        }
        for call in &extracted.calls {
            let Some(owner) = call.owner else {
                continue;
            };
            let from = format!(
                "{}:{}:{}",
                extracted.defs[owner].kind,
                candidate.relative,
                extracted.qualified(owner)
            );
            transaction.execute(
                "INSERT INTO refs(from_node,name,path,line) VALUES(?1,?2,?3,?4)",
                params![from, call.name, candidate.relative, call.line],
            )?;
        }
        for import in &extracted.imports {
            transaction.execute(
                "INSERT INTO imports(path,source,names,line) VALUES(?1,?2,?3,?4)",
                params![
                    candidate.relative,
                    import.source,
                    import.names.join("\n"),
                    import.line
                ],
            )?;
        }
    }
    transaction.execute(
        "INSERT OR REPLACE INTO files(path,language,size,mtime,hash,node_count,indexed_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            candidate.relative,
            language,
            candidate.size as i64,
            candidate.mtime,
            digest,
            count,
            now_ms()
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn walk(root: &Path) -> (Vec<Candidate>, bool) {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    let mut complete = true;
    while let Some((directory, prefix, depth)) = stack.pop() {
        if found.len() >= MAX_FILES {
            complete = false;
            break;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            complete = false;
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                complete = false;
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth >= MAX_DEPTH || SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                stack.push((entry.path(), relative, depth + 1));
                continue;
            }
            if lang::detect(&relative).is_none() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                complete = false;
                continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            found.push(Candidate {
                relative,
                size: metadata.len(),
                mtime: modified_ms(&metadata),
            });
        }
    }
    found.sort_by(|left, right| left.relative.cmp(&right.relative));
    (found, complete)
}

fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Imports keyed by file, for the resolver.
pub fn load_imports(
    connection: &Connection,
) -> Result<HashMap<String, Vec<(String, Vec<String>)>>, Error> {
    let mut statement = connection.prepare("SELECT path, source, names FROM imports")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut map: HashMap<String, Vec<(String, Vec<String>)>> = HashMap::new();
    for row in rows {
        let (path, source, names) = row?;
        map.entry(path).or_default().push((
            source,
            names
                .split('\n')
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect(),
        ));
    }
    Ok(map)
}
