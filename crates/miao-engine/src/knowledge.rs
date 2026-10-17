//! Small, reviewable workspace knowledge. Content is advisory; source freshness is not claim truth.
use crate::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, path::Path};

pub const PATH: &str = ".miao/knowledge.json";
pub const STORE_LIMIT: usize = 128 * 1024;
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    RepoFact,
    Preference,
    Constraint,
    FileIndex,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub revision: u64,
    pub title: String,
    pub kind: Kind,
    pub body: String,
    pub derivation: String,
    pub sources: Vec<Source>,
    pub location: String,
    pub origin_session: String,
    pub updated_at_ms: u64,
    pub expires_at_ms: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub version: u32,
    pub revision: u64,
    pub notes: BTreeMap<String, Note>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            notes: BTreeMap::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Query {
    List {
        #[serde(default)]
        query: String,
        #[serde(default = "limit")]
        limit: usize,
    },
    Get {
        id: String,
        #[serde(default)]
        include_stale: bool,
    },
    Put {
        id: String,
        expected_revision: u64,
        expected_store_sha256: Option<String>,
        title: String,
        kind: Kind,
        body: String,
        #[serde(default)]
        derivation: String,
        #[serde(default)]
        sources: Vec<Source>,
        ttl_seconds: Option<u64>,
    },
    IndexFile {
        id: String,
        path: String,
        expected_revision: u64,
        expected_store_sha256: Option<String>,
    },
    Delete {
        id: String,
        expected_revision: u64,
        expected_store_sha256: Option<String>,
    },
}
fn limit() -> usize {
    10
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        && value != "."
        && value != ".."
}
pub fn source_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.starts_with('@')
        && !value.chars().any(char::is_control)
        && !value.contains('\\')
        && value != PATH
        && Path::new(value)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}
fn sources_valid(sources: &[Source]) -> bool {
    sources.len() <= 8
        && sources.iter().all(|source| {
            source_path(&source.path)
                && source.sha256.len() == 64
                && source.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}
impl Query {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let query: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        let valid = match &query {
            Self::List { query, limit } => query.len() <= 256 && (1..=20).contains(limit),
            Self::Get { id: value, .. } | Self::Delete { id: value, .. } => id(value),
            Self::IndexFile {
                id: value, path, ..
            } => id(value) && source_path(path),
            Self::Put {
                id: value,
                title,
                kind,
                body,
                derivation,
                sources,
                ttl_seconds,
                ..
            } => {
                id(value)
                    && !title.trim().is_empty()
                    && title.len() <= 160
                    && body.len() <= 8192
                    && derivation.len() <= 2048
                    && sources_valid(sources)
                    && (!matches!(kind, Kind::RepoFact | Kind::FileIndex)
                        || (!sources.is_empty() && !derivation.trim().is_empty()))
                    && ttl_seconds.is_none_or(|ttl| (1..=30 * 24 * 3600).contains(&ttl))
            }
        };
        if !valid
            || query.expected_store().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(query)
    }
    pub fn writes(&self) -> bool {
        matches!(
            self,
            Self::Put { .. } | Self::IndexFile { .. } | Self::Delete { .. }
        )
    }
    pub fn expected_store(&self) -> Option<&str> {
        match self {
            Self::Put {
                expected_store_sha256,
                ..
            }
            | Self::IndexFile {
                expected_store_sha256,
                ..
            }
            | Self::Delete {
                expected_store_sha256,
                ..
            } => expected_store_sha256.as_deref(),
            _ => None,
        }
    }
}

pub fn load(root: &cap_std::fs::Dir, path: &Path) -> Result<(Document, Option<String>), ToolError> {
    let file = match root.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Document::default(), None))
        }
        Err(error) => return Err(error.into()),
    };
    let mut bytes = vec![];
    file.take(STORE_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > STORE_LIMIT {
        return Err(ToolError::External(
            "knowledge store exceeds 128 KiB".into(),
        ));
    }
    let document: Document = serde_json::from_slice(&bytes).map_err(|_| {
        ToolError::External("knowledge store is invalid; existing contents were preserved".into())
    })?;
    if document.version != 1
        || document.notes.len() > 64
        || document.notes.iter().any(|(key, note)| {
            !id(key)
                || note.title.len() > 160
                || note.body.len() > 8192
                || note.derivation.len() > 2048
                || !sources_valid(&note.sources)
                || note.revision == 0
                || note.revision > document.revision
        })
    {
        return Err(ToolError::External(
            "unsupported or invalid knowledge store; existing contents were preserved".into(),
        ));
    }
    Ok((document, Some(crate::permission::digest(&bytes))))
}

pub fn save(
    root: &cap_std::fs::Dir,
    path: &Path,
    document: &Document,
    expected: Option<String>,
) -> Result<Value, ToolError> {
    let text = serde_json::to_string_pretty(document).map_err(|_| ToolError::InvalidInput)?;
    if text.len() > STORE_LIMIT || document.notes.len() > 64 {
        return Err(ToolError::External(
            "knowledge capacity exceeded; existing contents were preserved".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        root.create_dir_all(parent)?;
    }
    crate::file_mutation::apply(
        root,
        path,
        crate::file_mutation::Mutation::Write(crate::file_mutation::WriteInput {
            path: path.to_string_lossy().into(),
            text,
            expected_sha256: expected,
        }),
        None,
    )
}

pub fn index(path: &str, bytes: &[u8]) -> Result<String, ToolError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ToolError::InvalidInput)?;
    let declaration=regex::Regex::new(r"^\s*(?:(?:pub(?:\([^)]*\))?|export|default|async)\s+)*(fn|function|class|struct|enum|interface|type|trait)\s+([A-Za-z_$][A-Za-z0-9_$]*)").map_err(|_|ToolError::InvalidInput)?;
    let candidates:Vec<_>=text.lines().enumerate().filter_map(|(line,text)|declaration.captures(text).map(|capture|json!({"line":line+1,"kind":&capture[1],"name":capture[2].chars().take(80).collect::<String>()}))).take(32).collect();
    Ok(json!({"path":path,"bytes":bytes.len(),"lines":text.lines().count(),"symbol_candidates":candidates,"symbol_coverage":"lexical_only","instructions":"Use current source or LSP for authoritative symbol resolution."}).to_string())
}
