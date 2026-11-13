//! One parse per file into the rows the index stores.
//!
//! Nesting and call ownership come from a single depth-first walk: a definition
//! is pushed on the stack before its children are visited, so a call node
//! records the innermost enclosing definition as its owner without a second
//! containment pass.

use crate::lang::{self, ImportSpec};
use tree_sitter::{Node, Parser};

/// Bump when a change to this module makes existing rows wrong. The store wipes
/// itself rather than mixing rows produced by two extractors.
pub const VERSION: u32 = 2;

const MAX_DEFS: usize = 2000;
const MAX_CALLS: usize = 8000;
const SIGNATURE_CHARS: usize = 200;
const DOCSTRING_LINES: usize = 6;

pub struct Def {
    pub kind: &'static str,
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_col: u32,
    pub end_col: u32,
    pub signature: String,
    pub docstring: Option<String>,
    pub exported: bool,
    pub container: Option<usize>,
}

pub struct CallSite {
    pub name: String,
    pub line: u32,
    pub owner: Option<usize>,
}

pub struct Extracted {
    pub defs: Vec<Def>,
    pub calls: Vec<CallSite>,
    pub imports: Vec<ImportSpec>,
}

impl Extracted {
    /// The dotted name a definition is reachable under: container first, so a
    /// method reads `Tools::prepare` and a nested function keeps its parent.
    pub fn qualified(&self, index: usize) -> String {
        let def = &self.defs[index];
        match def.container {
            Some(container) => format!("{}::{}", self.qualified(container), def.name),
            None => def.name.clone(),
        }
    }
}

pub fn extract(path: &str, source: &str) -> Option<Extracted> {
    let language = lang::detect(path)?;
    let grammar = lang::language(language)?;
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;
    let bytes = source.as_bytes();
    let tree = parser.parse(bytes, None)?;
    let mut walker = Walker {
        language,
        source: bytes,
        lines: source.lines().collect(),
        defs: Vec::new(),
        calls: Vec::new(),
        stack: Vec::new(),
    };
    walker.visit(tree.root_node());
    let imports = lang::imports(language, tree.root_node(), bytes);
    Some(Extracted {
        defs: walker.defs,
        calls: walker.calls,
        imports,
    })
}

struct Walker<'a> {
    language: &'static str,
    source: &'a [u8],
    lines: Vec<&'a str>,
    defs: Vec<Def>,
    calls: Vec<CallSite>,
    stack: Vec<usize>,
}

impl Walker<'_> {
    fn visit(&mut self, node: Node) {
        let pushed = self.definition(node);
        if self.calls.len() < MAX_CALLS {
            if let Some(name) = lang::callee(self.language, node, self.source) {
                if !lang::builtin(self.language).contains(&name.as_str()) {
                    self.calls.push(CallSite {
                        name,
                        line: node.start_position().row as u32 + 1,
                        owner: self.stack.last().copied(),
                    });
                }
            }
        }
        self.descend(node);
        if pushed {
            self.stack.pop();
        }
    }

    fn descend(&mut self, node: Node) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.is_missing() {
                continue;
            }
            self.visit(child);
        }
    }

    fn definition(&mut self, node: Node) -> bool {
        if self.defs.len() >= MAX_DEFS {
            return false;
        }
        let Some((kind, name)) = lang::definition(self.language, node, self.source) else {
            return false;
        };
        if name.is_empty() || !name.chars().next().is_some_and(|first| first.is_alphanumeric() || first == '_') {
            return false;
        }
        let start = node.start_position();
        let index = self.defs.len();
        let container = self.stack.last().copied();
        if let Some(container) = container {
            if self.defs[container].kind == kind && self.defs[container].name == name {
                return false;
            }
        }
        self.defs.push(Def {
            kind,
            name,
            start_line: start.row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            start_col: start.column as u32,
            end_col: node.end_position().column as u32,
            signature: signature(self.source, node),
            docstring: self.docstring(start.row),
            exported: exported(self.language, node, self.source),
            container,
        });
        self.stack.push(index);
        true
    }

    fn docstring(&self, row: usize) -> Option<String> {
        let mut collected = Vec::new();
        let mut cursor = row;
        while cursor > 0 && collected.len() < DOCSTRING_LINES {
            cursor -= 1;
            let line = self.lines.get(cursor)?.trim();
            let comment = line.starts_with("///")
                || line.starts_with("//!")
                || line.starts_with("//")
                || line.starts_with('#')
                || line.starts_with('*')
                || line.starts_with("/*")
                || line.starts_with("\"\"\"")
                || line.starts_with("'''");
            if !comment {
                break;
            }
            collected.push(
                line.trim_start_matches(['/', '*', '#', '"', '\'', ' ', '!'])
                    .trim()
                    .to_owned(),
            );
        }
        if collected.is_empty() {
            return None;
        }
        collected.reverse();
        Some(collected.join(" "))
    }
}

fn signature(source: &[u8], node: Node) -> String {
    let text = std::str::from_utf8(&source[node.byte_range()]).unwrap_or_default();
    let first = text.lines().next().unwrap_or_default().trim();
    let clipped = first.chars().take(SIGNATURE_CHARS).collect::<String>();
    clipped.trim_end().to_owned()
}

fn exported(language: &str, node: Node, source: &[u8]) -> bool {
    if language == "rust" {
        return std::str::from_utf8(&source[node.byte_range()])
            .unwrap_or_default()
            .trim_start()
            .starts_with("pub");
    }
    let mut cursor = node.parent();
    while let Some(parent) = cursor {
        if parent.kind() == "export_statement" {
            return true;
        }
        cursor = parent.parent();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::extract;

    #[test]
    fn stdlib_calls_are_not_recorded_and_project_calls_are() {
        let found = extract(
            "src/lib.rs",
            "pub fn run() {\n    self.render();\n    println!(\"hi\");\n    value.clone();\n}\n",
        )
        .expect("extract");
        let names = found.calls.iter().map(|call| call.name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"render"), "{names:?}");
        assert!(!names.contains(&"println"), "{names:?}");
        assert!(!names.contains(&"clone"), "{names:?}");
    }

    #[test]
    fn a_nested_definition_keeps_its_container_as_owner() {
        let found = extract(
            "src/lib.rs",
            "impl Tools {\n    pub fn prepare(&self) {\n        self.assess();\n    }\n}\n",
        )
        .expect("extract");
        assert_eq!(found.qualified(1), "Tools::prepare");
        assert_eq!(found.calls[0].owner, Some(1));
    }
}
