//! Built-in code index tools, backed by `miao-codegraph`.
//!
//! The index lives beside the engine store rather than in the workspace: it is
//! a cache of the source tree, not a project artifact, so indexing never shows
//! up as a working-tree change and never needs a permission prompt to write.

use crate::protocol::ToolDefinition;
use crate::tools::ToolError;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Subdirectory of the engine store that holds one index per workspace.
pub const DIRECTORY: &str = "codegraph";
pub const NAMES: &[&str] = &[
    "codegraph_explore",
    "codegraph_node",
    "codegraph_callers",
    "codegraph_status",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExploreInput {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    max_chars: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeInput {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallersInput {
    symbol: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusInput {}

pub fn is_codegraph(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "codegraph_explore".into(),
            description: "Answer a code question from the local symbol index instead of grepping. One call returns the verbatim, line-numbered source of the symbols the query names plus the call paths between them, so treat what it returns as already read. Name symbols, or a file (`path` or `path:12-40`), in the query. Prefer it over grep/read when you need to understand or locate code across files; follow up with another explore naming what it says it left out rather than reading those files.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 24, "default": 6},
                    "max_chars": {"type": "integer", "minimum": 2000, "maximum": 200000}
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "codegraph_node".into(),
            description: "Read one file or one symbol from the index. Without `symbol` it returns a workspace file's current source with line numbers plus the files that import it — the shape read_file gives, with the blast radius attached. With `symbol` it returns that definition's source, its callers and what it calls, so an edit decision is made in one call.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "maxLength": 4096},
                    "symbol": {"type": "string", "maxLength": 256},
                    "offset": {"type": "integer", "minimum": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 2000}
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "codegraph_callers".into(),
            description: "List the call sites of a symbol, with the file and line of each call. Use it to size the impact of changing that symbol before editing it.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "minLength": 1, "maxLength": 256},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}
                },
                "required": ["symbol"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "codegraph_status".into(),
            description: "Report index coverage: files, symbols, call edges, unresolved references, languages, store size and what the last refresh did.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
    ]
}

/// Validate an input before it reaches the permission layer and return the
/// workspace resource the call touches. `node` names a path, so it is evaluated
/// as a read of that path; the others read the workspace as a whole.
pub fn parse(name: &str, input: &Value) -> Result<String, ToolError> {
    Ok(match name {
        "codegraph_explore" => {
            let parsed: ExploreInput = decode(input.clone())?;
            if parsed.query.trim().is_empty() {
                return Err(ToolError::InvalidInput);
            }
            ".".to_owned()
        }
        "codegraph_node" => {
            let parsed: NodeInput = decode(input.clone())?;
            match (parsed.path.as_deref(), parsed.symbol.as_deref()) {
                (None, None) => return Err(ToolError::InvalidInput),
                (path, _) => path.unwrap_or(".").to_owned(),
            }
        }
        "codegraph_callers" => {
            let parsed: CallersInput = decode(input.clone())?;
            if parsed.symbol.trim().is_empty() {
                return Err(ToolError::InvalidInput);
            }
            ".".to_owned()
        }
        "codegraph_status" => {
            let _: StatusInput = decode(input.clone())?;
            ".".to_owned()
        }
        _ => return Err(ToolError::Unsupported),
    })
}

pub async fn execute(
    name: &str,
    input: Value,
    root: PathBuf,
    database: PathBuf,
) -> Result<Value, ToolError> {
    let name = name.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut index = miao_codegraph::Index::open(&root, &database).map_err(external)?;
        let answer = match name.as_str() {
            "codegraph_explore" => {
                let parsed: ExploreInput = decode(input)?;
                index.explore(&parsed.query, parsed.limit, parsed.max_chars)
            }
            "codegraph_node" => {
                let parsed: NodeInput = decode(input)?;
                index.node(
                    parsed.path.as_deref(),
                    parsed.symbol.as_deref(),
                    parsed.offset,
                    parsed.limit,
                )
            }
            "codegraph_callers" => {
                let parsed: CallersInput = decode(input)?;
                index.callers(&parsed.symbol, parsed.limit)
            }
            "codegraph_status" => {
                let _: StatusInput = decode(input)?;
                index.status()
            }
            _ => return Err(ToolError::Unsupported),
        }
        .map_err(external)?;
        Ok(json!({
            "content": answer.content,
            "index": {
                "files": answer.files,
                "symbols": answer.nodes,
                "refreshed": answer.refreshed,
                "pending": answer.pending,
                "millis": answer.millis
            }
        }))
    })
    .await
    .map_err(|_| ToolError::Io(std::io::Error::other("codegraph worker failed")))?
}

fn decode<T: DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)
}

fn external(error: impl std::fmt::Display) -> ToolError {
    ToolError::External(error.to_string())
}
