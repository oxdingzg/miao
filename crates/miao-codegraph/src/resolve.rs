//! Call-reference resolution: turn the callee names extraction recorded into
//! `calls` edges, in the order that costs the fewest false links.
//!
//! The tiers are same-file, imported name, globally unique name, then a unique
//! qualified suffix. Anything left over stays pending, because a later sync can
//! introduce the definition that satisfies it.

use crate::{sync, Error};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

const MAX_ATTEMPTS: i64 = 3;

/// One unresolved call site waiting for the resolver.
struct Pending {
    id: i64,
    from: String,
    name: String,
    path: String,
    line: i64,
}

pub(crate) struct Symbol {
    id: String,
    qualified: String,
}

#[derive(Default)]
pub(crate) struct Symbols {
    by_path: HashMap<String, HashMap<String, String>>,
    by_name: HashMap<String, Vec<Symbol>>,
    paths: HashSet<String>,
    directories: HashMap<String, Vec<String>>,
}

pub fn run(connection: &mut Connection, max_refs: usize) -> Result<usize, Error> {
    let symbols = load(connection)?;
    let imports = sync::load_imports(connection)?;
    let refs = pending(connection, max_refs)?;
    let mut unresolved = 0;
    for pending in refs {
        match resolve(&symbols, &imports, &pending.name, &pending.path) {
            Some(target) => {
                connection.execute("DELETE FROM refs WHERE id=?1", params![pending.id])?;
                connection.execute(
                    "INSERT INTO edges(source,target,kind,line,provenance) VALUES(?1,?2,'calls',?3,'resolve')",
                    params![pending.from, target, pending.line],
                )?;
            }
            None => {
                unresolved += 1;
                connection.execute(
                    "UPDATE refs SET attempts=attempts+1, status=CASE WHEN attempts+1>=?2 THEN 'failed' ELSE 'pending' END WHERE id=?1",
                    params![pending.id, MAX_ATTEMPTS],
                )?;
            }
        }
    }
    Ok(unresolved)
}

fn pending(connection: &Connection, limit: usize) -> Result<Vec<Pending>, Error> {
    let mut statement = connection.prepare(
        "SELECT id, from_node, name, path, line FROM refs WHERE status='pending' ORDER BY attempts, id LIMIT ?1",
    )?;
    let rows = statement.query_map([limit as i64], |row| {
        Ok(Pending {
            id: row.get(0)?,
            from: row.get(1)?,
            name: row.get(2)?,
            path: row.get(3)?,
            line: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(crate) fn load(connection: &Connection) -> Result<Symbols, Error> {
    let mut symbols = Symbols::default();
    let mut statement = connection.prepare("SELECT id, name, qualified, path FROM nodes")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, name, qualified, path) = row?;
        symbols
            .by_path
            .entry(path.clone())
            .or_default()
            .entry(name.to_lowercase())
            .or_insert_with(|| id.clone());
        symbols
            .by_name
            .entry(name.to_lowercase())
            .or_default()
            .push(Symbol {
                id: id.clone(),
                qualified,
            });
        symbols.paths.insert(path.clone());
        let directory = directory_of(&path).to_owned();
        symbols.directories.entry(directory).or_default().push(path);
    }
    Ok(symbols)
}

fn resolve(
    symbols: &Symbols,
    imports: &crate::sync::Imports,
    name: &str,
    path: &str,
) -> Option<String> {
    let lowered = name.to_lowercase();
    if let Some(id) = same_file(symbols, path, &lowered) {
        return Some(id);
    }
    if let Some(scoped) = imports.get(path) {
        for (source, names) in scoped {
            if !names
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(name))
            {
                continue;
            }
            let Some(target) = import_target(symbols, source, path) else {
                continue;
            };
            if let Some(id) = same_file(symbols, &target, &lowered) {
                return Some(id);
            }
        }
    }
    let candidates = symbols.by_name.get(&lowered)?;
    if candidates.len() == 1 {
        return Some(candidates[0].id.clone());
    }
    let suffix = format!("::{lowered}");
    let preferred = candidates
        .iter()
        .filter(|candidate| candidate.qualified.to_lowercase().ends_with(&suffix))
        .collect::<Vec<_>>();
    (preferred.len() == 1).then(|| preferred[0].id.clone())
}

fn same_file(symbols: &Symbols, path: &str, lowered: &str) -> Option<String> {
    symbols.by_path.get(path)?.get(lowered).cloned()
}

/// The workspace file an import names, for the spellings this index understands.
pub(crate) fn import_target(symbols: &Symbols, source: &str, from: &str) -> Option<String> {
    let candidate = if let Some(module) = source.strip_prefix("rust::") {
        rust_target(symbols, module, from)
    } else if let Some(module) = source.strip_prefix("python::") {
        python_target(symbols, module, from)
    } else if let Some(module) = source.strip_prefix("go::") {
        go_target(symbols, module)
    } else {
        script_target(symbols, source, from)
    }?;
    symbols.paths.contains(&candidate).then_some(candidate)
}

fn script_target(symbols: &Symbols, source: &str, from: &str) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let mut parts = directory_of(from)
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    for segment in source.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    let mut candidates = vec![joined.clone()];
    for extension in ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] {
        candidates.push(format!("{joined}.{extension}"));
    }
    let stripped = joined
        .strip_suffix(".js")
        .or_else(|| joined.strip_suffix(".jsx"))
        .or_else(|| joined.strip_suffix(".mjs"))
        .or_else(|| joined.strip_suffix(".cjs"));
    if let Some(stripped) = stripped {
        for extension in ["ts", "tsx"] {
            candidates.push(format!("{stripped}.{extension}"));
        }
    }
    for extension in ["ts", "tsx", "js", "jsx"] {
        candidates.push(format!("{joined}/index.{extension}"));
    }
    candidates
        .into_iter()
        .find(|candidate| symbols.paths.contains(candidate))
}

fn python_target(symbols: &Symbols, module: &str, from: &str) -> Option<String> {
    let (mut base, rest) = match module.strip_prefix('.') {
        Some(rest) => {
            let mut base = directory_of(from).to_owned();
            let mut remaining = rest;
            while let Some(next) = remaining.strip_prefix('.') {
                base = directory_of(&base).to_owned();
                remaining = next;
            }
            (base, remaining)
        }
        None => (String::new(), module),
    };
    let path = rest.replace('.', "/");
    if base.is_empty() {
        base = path;
    } else if !path.is_empty() {
        base = format!("{base}/{path}");
    }
    [format!("{base}.py"), format!("{base}/__init__.py")]
        .into_iter()
        .find(|candidate| symbols.paths.contains(candidate))
}

fn go_target(symbols: &Symbols, module: &str) -> Option<String> {
    let package = module.rsplit('/').next()?;
    let (directory, paths) = symbols.directories.iter().find(|(directory, _)| {
        directory
            .rsplit('/')
            .next()
            .is_some_and(|name| name == package)
    })?;
    let _ = directory;
    paths.first().cloned()
}

fn rust_target(symbols: &Symbols, module: &str, from: &str) -> Option<String> {
    let segments = module
        .split("::")
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let first = *segments.first()?;
    let src = crate_root(from)?;
    let (mut base, rest) = match first {
        "crate" => (src, &segments[1..]),
        "self" => (directory_of(from).to_owned(), &segments[1..]),
        "super" => (directory_of(directory_of(from)).to_owned(), &segments[1..]),
        "std" | "core" | "alloc" => return None,
        _ => (src, &segments[..]),
    };
    let path = rest.join("/");
    if !path.is_empty() {
        base = format!("{base}/{path}");
    }
    [format!("{base}.rs"), format!("{base}/mod.rs"), base]
        .into_iter()
        .find(|candidate| symbols.paths.contains(candidate))
}

/// The `src` directory of the crate a Rust file belongs to.
fn crate_root(path: &str) -> Option<String> {
    let segments = path.split('/').collect::<Vec<_>>();
    let index = segments.iter().rposition(|segment| *segment == "src")?;
    Some(segments[..=index].join("/"))
}

fn directory_of(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("")
}
