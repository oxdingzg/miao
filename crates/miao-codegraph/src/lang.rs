//! Which files are indexed, and how each grammar's node kinds map onto
//! symbols, calls and imports.
//!
//! Every mapping is written as an explicit match on the node kind instead of a
//! tree-sitter query: a query that names one node kind the pinned grammar does
//! not have fails to compile and takes the whole language down with it, while a
//! match arm simply never fires.

use tree_sitter::{Language, Node};

/// Extensions in the order they win: `.d.ts` is TypeScript, not JavaScript.
const EXTENSIONS: &[(&str, &str)] = &[
    ("ts", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("tsx", "tsx"),
    ("js", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("jsx", "javascript"),
    ("rs", "rust"),
    ("py", "python"),
    ("pyi", "python"),
    ("go", "go"),
];

pub const LANGUAGES: &[&str] = &["typescript", "tsx", "javascript", "rust", "python", "go"];

pub fn language(id: &str) -> Option<Language> {
    Some(match id {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => return None,
    })
}

pub fn detect(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".d.ts") {
        return Some("typescript");
    }
    let extension = name.rsplit_once('.').map(|(_, extension)| extension)?;
    EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, language)| *language)
}

/// An import statement reduced to the module it names and the bindings it
/// introduces. `source` keeps the spelling from the source file, because
/// resolution needs to know whether it was relative.
pub struct ImportSpec {
    pub source: String,
    pub names: Vec<String>,
    pub line: u32,
}

pub fn text(node: Node, source: &[u8]) -> Option<String> {
    std::str::from_utf8(&source[node.byte_range()])
        .ok()
        .map(str::to_owned)
}

fn field(node: Node, name: &str, source: &[u8]) -> Option<String> {
    text(node.child_by_field_name(name)?, source)
}

fn identifier_like(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|value| value.is_alphanumeric() || value == '_' || value == '$')
}

/// Names that never resolve to a workspace definition. Recording them would
/// cost a lookup per call site and inflate the unresolved count with stdlib
/// noise, so they are dropped at extraction time. The list stays deliberately
/// short: a name a project is likely to define itself (`new`, `get`, `run`,
/// `render`, `Close`) is kept so its calls can still land.
pub fn builtin(language: &str) -> &'static [&'static str] {
    match language {
        "rust" => &[
            "println",
            "print",
            "eprintln",
            "eprint",
            "format",
            "write",
            "writeln",
            "vec",
            "panic",
            "assert",
            "assert_eq",
            "assert_ne",
            "debug_assert",
            "debug_assert_eq",
            "unreachable",
            "todo",
            "unimplemented",
            "matches",
            "concat",
            "include_str",
            "include_bytes",
            "env",
            "stringify",
            "dbg",
            "unwrap",
            "expect",
            "clone",
            "to_string",
            "to_owned",
            "as_str",
            "as_ref",
            "as_mut",
            "len",
            "is_empty",
            "iter",
            "iter_mut",
            "into_iter",
            "collect",
            "and_then",
            "ok_or",
            "ok_or_else",
            "unwrap_or",
            "unwrap_or_else",
            "unwrap_or_default",
            "default",
        ],
        "typescript" | "tsx" | "javascript" => &[
            "log",
            "error",
            "warn",
            "info",
            "debug",
            "stringify",
            "parse",
            "keys",
            "values",
            "entries",
            "assign",
            "then",
            "catch",
            "finally",
            "map",
            "filter",
            "reduce",
            "forEach",
            "push",
            "pop",
            "slice",
            "splice",
            "join",
            "split",
            "trim",
            "toLowerCase",
            "toUpperCase",
            "replace",
            "includes",
            "indexOf",
            "sort",
            "require",
            "resolve",
        ],
        "python" => &[
            "print",
            "len",
            "range",
            "str",
            "int",
            "float",
            "bool",
            "dict",
            "list",
            "set",
            "append",
            "extend",
            "items",
            "format",
            "join",
            "split",
            "strip",
            "startswith",
            "endswith",
            "lower",
            "upper",
            "replace",
            "super",
        ],
        "go" => &[
            "len", "cap", "make", "append", "copy", "delete", "panic", "recover", "print",
            "println",
        ],
        _ => &[],
    }
}

/// The symbol a definition node introduces, or `None` when the node is not a
/// definition in this language.
pub fn definition(language: &str, node: Node, source: &[u8]) -> Option<(&'static str, String)> {
    let name = |field_name: &str| field(node, field_name, source);
    Some(match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "function_declaration") => {
            ("function", name("name")?)
        }
        ("typescript" | "tsx" | "javascript", "generator_function_declaration") => {
            ("function", name("name")?)
        }
        ("typescript" | "tsx" | "javascript", "class_declaration") => ("class", name("name")?),
        ("typescript" | "tsx" | "javascript", "method_definition") => ("method", name("name")?),
        ("typescript" | "tsx", "interface_declaration") => ("interface", name("name")?),
        ("typescript" | "tsx", "type_alias_declaration") => ("type", name("name")?),
        ("typescript" | "tsx" | "javascript", "enum_declaration") => ("enum", name("name")?),
        ("typescript" | "tsx" | "javascript", "variable_declarator") => {
            let value = node.child_by_field_name("value")?;
            if !matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "function"
            ) {
                return None;
            }
            ("function", name("name")?)
        }
        ("rust", "function_item") => ("function", name("name")?),
        ("rust", "struct_item") => ("struct", name("name")?),
        ("rust", "enum_item") => ("enum", name("name")?),
        ("rust", "trait_item") => ("trait", name("name")?),
        ("rust", "union_item") => ("struct", name("name")?),
        ("rust", "impl_item") => {
            let kind = node
                .child_by_field_name("type")
                .or_else(|| node.child_by_field_name("trait"))?;
            ("impl", text(kind, source)?)
        }
        ("rust", "mod_item") => ("module", name("name")?),
        ("rust", "const_item" | "static_item") => ("const", name("name")?),
        ("rust", "type_item") => ("type", name("name")?),
        ("rust", "macro_definition") => ("macro", name("name")?),
        ("python", "function_definition") => ("function", name("name")?),
        ("python", "class_definition") => ("class", name("name")?),
        ("go", "function_declaration") => ("function", name("name")?),
        ("go", "method_declaration") => ("method", name("name")?),
        ("go", "type_spec") => ("type", name("name")?),
        _ => return None,
    })
}

/// The callee name of a call node. Member and scoped forms keep only the last
/// segment, which is what a same-file or imported-name lookup can match.
pub fn callee(language: &str, node: Node, source: &[u8]) -> Option<String> {
    let callee = match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "call_expression") => {
            node.child_by_field_name("function")?
        }
        ("typescript" | "tsx" | "javascript", "new_expression") => {
            node.child_by_field_name("constructor")?
        }
        ("rust", "call_expression") => node.child_by_field_name("function")?,
        ("rust", "macro_invocation") => node.child_by_field_name("macro")?,
        ("python", "call") => node.child_by_field_name("function")?,
        ("go", "call_expression") => node.child_by_field_name("function")?,
        _ => return None,
    };
    let value = match callee.kind() {
        "identifier" | "field_identifier" | "property_identifier" | "type_identifier" => {
            text(callee, source)?
        }
        "member_expression" => text(callee.child_by_field_name("property")?, source)?,
        "field_expression" => text(callee.child_by_field_name("field")?, source)?,
        "selector_expression" => text(callee.child_by_field_name("field")?, source)?,
        "attribute" => text(callee.child_by_field_name("attribute")?, source)?,
        "scoped_identifier" => text(callee.child_by_field_name("name")?, source)?,
        "generic_function" => text(callee.child_by_field_name("function")?, source)?,
        "parenthesized_expression" => text(callee, source)?,
        _ => return None,
    };
    identifier_like(&value).then_some(value)
}

fn identifiers(value: &str) -> Vec<String> {
    value
        .split(|character: char| {
            !(character.is_alphanumeric() || character == '_' || character == '$')
        })
        .filter(|part| !part.is_empty())
        .filter(|part| identifier_like(part))
        .map(str::to_owned)
        .collect()
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`'])
        .to_owned()
}

pub fn imports(language: &str, root: Node, source: &[u8]) -> Vec<ImportSpec> {
    let mut found = Vec::new();
    collect_imports(language, root, source, &mut found);
    found
}

fn collect_imports(language: &str, node: Node, source: &[u8], found: &mut Vec<ImportSpec>) {
    match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "import_statement" | "export_statement") => {
            if let Some(spec) = script_import(language, node, source) {
                found.push(spec);
                return;
            }
        }
        ("rust", "use_declaration") => {
            if let Some(spec) = rust_use(node, source) {
                found.push(spec);
            }
            return;
        }
        ("python", "import_statement" | "import_from_statement") => {
            if let Some(spec) = python_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("go", "import_spec") => {
            if let Some(spec) = go_import(node, source) {
                found.push(spec);
            }
            return;
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.is_missing() {
            continue;
        }
        collect_imports(language, child, source, found);
    }
}

fn script_import(_language: &str, node: Node, source: &[u8]) -> Option<ImportSpec> {
    let target = unquote(&field(node, "source", source)?);
    let whole = text(node, source)?;
    let clause = match whole.split_once(" from ") {
        Some((clause, _)) => clause.to_owned(),
        None if whole.starts_with("export") => return None,
        None => whole,
    };
    let names = identifiers(&clause)
        .into_iter()
        .filter(|name| !matches!(name.as_str(), "import" | "export" | "type" | "as" | "from"))
        .collect();
    Some(ImportSpec {
        source: target,
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn rust_use(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole
        .trim_start_matches("use ")
        .trim_end_matches(';')
        .trim();
    let (prefix, names) = match body.split_once('{') {
        Some((prefix, rest)) => {
            let inner = rest.trim_end_matches(['}', ';']);
            let names = inner
                .split(',')
                .filter_map(|entry| {
                    let entry = entry.trim();
                    if entry.is_empty() || entry == "self" {
                        return None;
                    }
                    let entry = match entry.split_once(" as ") {
                        Some((_, alias)) => alias.trim().to_owned(),
                        None => entry.to_owned(),
                    };
                    entry
                        .rsplit("::")
                        .next()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                })
                .collect();
            (prefix.trim_end_matches("::").to_owned(), names)
        }
        None => {
            let (path, alias) = match body.split_once(" as ") {
                Some((path, alias)) => (path.trim(), Some(alias.trim().to_owned())),
                None => (body, None),
            };
            let name = alias.or_else(|| path.rsplit("::").next().map(str::to_owned))?;
            let prefix = path
                .rsplit_once("::")
                .map(|(prefix, _)| prefix.to_owned())
                .unwrap_or_default();
            (prefix, vec![name])
        }
    };
    Some(ImportSpec {
        source: format!("rust::{prefix}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn python_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole.trim();
    let (module, names) = match body.strip_prefix("from ") {
        Some(rest) => {
            let (module, names) = rest.split_once(" import ")?;
            (
                module.trim().to_owned(),
                names
                    .split(',')
                    .filter_map(|entry| {
                        let entry = entry.trim().trim_matches(['(', ')']);
                        let name = entry.split(" as ").next()?.trim();
                        (!name.is_empty() && name != "*").then(|| name.to_owned())
                    })
                    .collect(),
            )
        }
        None => {
            let rest = body.strip_prefix("import ")?;
            (rest.trim().to_owned(), identifiers(rest))
        }
    };
    Some(ImportSpec {
        source: format!("python::{module}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn go_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let trimmed = whole.trim();
    let target = unquote(
        trimmed
            .rsplit('"')
            .nth(1)
            .or_else(|| trimmed.rsplit('\'').nth(1))
            .map(|value| value.trim_start_matches('"').trim_start_matches('\''))
            .unwrap_or(trimmed),
    );
    let alias = trimmed
        .split_whitespace()
        .next()
        .filter(|value| *value != "\"");
    let names = match alias {
        Some(alias) if !alias.starts_with('"') => vec![alias.to_owned()],
        _ => target
            .rsplit('/')
            .next()
            .map(|name| vec![name.to_owned()])
            .unwrap_or_default(),
    };
    Some(ImportSpec {
        source: format!("go::{target}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_pick_one_language() {
        assert_eq!(detect("a/b/c.ts"), Some("typescript"));
        assert_eq!(detect("a/b/c.d.ts"), Some("typescript"));
        assert_eq!(detect("a/b/c.tsx"), Some("tsx"));
        assert_eq!(detect("a/b/c.jsx"), Some("javascript"));
        assert_eq!(detect("crates/x/src/lib.rs"), Some("rust"));
        assert_eq!(detect("a/b/README.md"), None);
        assert_eq!(detect("Makefile"), None);
    }
}
