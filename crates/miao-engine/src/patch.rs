use crate::tools::ToolError;
use cap_std::fs::Dir;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

const MAX_PATCH: usize = 262144;
const MAX_FILES: usize = 32;
const MAX_FILE: usize = 32768;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub patch: String,
}
impl Input {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        Ok(input)
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Action {
    Add,
    Update,
    Delete,
}
impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Line {
    Context,
    Remove,
    Insert,
}

#[derive(Clone)]
pub struct Operation {
    pub action: Action,
    pub path: String,
    content: String,
    hunks: Vec<Vec<(Line, String)>>,
}

fn valid_path(path: &str) -> Result<(), ToolError> {
    if path.is_empty()
        || path.len() > 1024
        || Path::new(path).is_absolute()
        || path.contains(['\\', '\0'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ToolError::InvalidInput);
    }
    Ok(())
}

/// Strict V4A-style parser. Unknown directives, a missing End Patch,
/// duplicate targets and empty Update sections fail closed before any
/// authorization or filesystem effect.
pub fn parse(input: &Input) -> Result<Vec<Operation>, ToolError> {
    if input.patch.len() > MAX_PATCH {
        return Err(ToolError::InvalidInput);
    }
    let mut operations: Vec<Operation> = Vec::new();
    let mut lines = input.patch.lines().peekable();
    if lines.next() != Some("*** Begin Patch") {
        return Err(ToolError::InvalidInput);
    }
    let mut closed = false;
    while let Some(line) = lines.next() {
        let (action, path) = if let Some(path) = line.strip_prefix("*** Add File: ") {
            (Action::Add, path)
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            (Action::Update, path)
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            (Action::Delete, path)
        } else if line == "*** End Patch" {
            closed = true;
            break;
        } else {
            return Err(ToolError::InvalidInput);
        };
        valid_path(path)?;
        if operations.iter().any(|op| op.path == path) {
            return Err(ToolError::InvalidInput);
        }
        let mut operation = Operation {
            action,
            path: path.to_owned(),
            content: String::new(),
            hunks: Vec::new(),
        };
        match action {
            Action::Add => {
                let mut content = String::new();
                while let Some(text) = lines.peek().and_then(|line| line.strip_prefix('+')) {
                    content.push_str(text);
                    content.push('\n');
                    lines.next();
                }
                if content.is_empty() || content.len() > MAX_FILE {
                    return Err(ToolError::InvalidInput);
                }
                operation.content = content;
            }
            Action::Update => {
                let mut hunk: Vec<(Line, String)> = Vec::new();
                loop {
                    let Some(line) = lines.peek() else { break };
                    if *line == "@@" {
                        if hunk.is_empty() {
                            lines.next();
                            continue;
                        }
                        operation.hunks.push(std::mem::take(&mut hunk));
                        lines.next();
                        continue;
                    }
                    let parsed = if let Some(text) = line.strip_prefix('+') {
                        Some((Line::Insert, text))
                    } else if let Some(text) = line.strip_prefix('-') {
                        Some((Line::Remove, text))
                    } else if let Some(text) = line.strip_prefix(' ') {
                        Some((Line::Context, text))
                    } else if line.is_empty() {
                        Some((Line::Context, ""))
                    } else {
                        None
                    };
                    let Some((kind, text)) = parsed else { break };
                    hunk.push((kind, text.to_owned()));
                    if hunk.len() > 4096 {
                        return Err(ToolError::InvalidInput);
                    }
                    lines.next();
                }
                if hunk.is_empty() {
                    return Err(ToolError::InvalidInput);
                }
                operation.hunks.push(hunk);
            }
            Action::Delete => {}
        }
        operations.push(operation);
        if operations.len() > MAX_FILES {
            return Err(ToolError::InvalidInput);
        }
    }
    if !closed || operations.is_empty() || lines.next().is_some() {
        return Err(ToolError::InvalidInput);
    }
    Ok(operations)
}

fn read_original(dir: &Dir, path: &str) -> Result<Option<Vec<u8>>, ToolError> {
    let metadata = match dir.symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_FILE as u64
    {
        return Err(ToolError::InvalidFile);
    }
    Ok(Some(dir.read(path)?))
}

/// Hunks apply at the first forward context/remove match; a hunk matching
/// nowhere after the cursor fails the whole file, never partially applies.
fn apply_hunks(original: &str, hunks: &[Vec<(Line, String)>]) -> Result<String, ToolError> {
    let lines: Vec<&str> = original.split('\n').collect();
    let mut output: Vec<String> = Vec::new();
    let mut cursor = 0;
    for hunk in hunks {
        let expected: Vec<&str> = hunk
            .iter()
            .filter(|(kind, _)| *kind != Line::Insert)
            .map(|(_, text)| text.as_str())
            .collect();
        let mut start = None;
        'scan: for candidate in cursor..=lines.len() {
            for (offset, text) in expected.iter().enumerate() {
                if candidate + offset >= lines.len() || lines[candidate + offset] != *text {
                    continue 'scan;
                }
            }
            start = Some(candidate);
            break;
        }
        let Some(start) = start else {
            return Err(ToolError::AmbiguousEdit);
        };
        while cursor < start {
            output.push(lines[cursor].to_owned());
            cursor += 1;
        }
        for (kind, text) in hunk {
            match kind {
                Line::Insert => output.push(text.clone()),
                Line::Context => {
                    output.push(lines[cursor].to_owned());
                    cursor += 1;
                }
                Line::Remove => cursor += 1,
            }
        }
    }
    while cursor < lines.len() {
        output.push(lines[cursor].to_owned());
        cursor += 1;
    }
    Ok(output.join("\n"))
}

fn normalize(original: &[u8]) -> Result<(String, bool, bool), ToolError> {
    let bom = original.starts_with(b"\xEF\xBB\xBF");
    let text = std::str::from_utf8(if bom { &original[3..] } else { original })
        .map_err(|_| ToolError::InvalidFile)?;
    let crlf = text.contains("\r\n");
    if crlf && text.replace("\r\n", "\n").contains('\r') {
        return Err(ToolError::InvalidFile);
    }
    Ok((
        if crlf {
            text.replace("\r\n", "\n")
        } else {
            text.to_owned()
        },
        bom,
        crlf,
    ))
}

fn restore(mut text: String, bom: bool, crlf: bool) -> Vec<u8> {
    if crlf {
        text = text.replace('\n', "\r\n");
    }
    if bom {
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend_from_slice(text.as_bytes());
        return bytes;
    }
    text.into_bytes()
}

/// A staged temporary owned until published or dropped; Drop removes the
/// temp so an aborted patch never leaves partial files behind.
struct Staged {
    dir: Dir,
    name: String,
    live: bool,
}
impl Staged {
    fn create(
        handle: &Dir,
        bytes: &[u8],
        permissions: Option<cap_std::fs::Permissions>,
    ) -> Result<Self, ToolError> {
        let name = format!(".miao-engine-{}.tmp", uuid::Uuid::new_v4());
        let mut file = handle.open_with(
            &name,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )?;
        file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        Ok(Self {
            dir: handle.try_clone()?,
            name,
            live: true,
        })
    }
    fn publish(self, handle: &Dir, name: &std::ffi::OsStr, created: bool) -> Result<(), ToolError> {
        let mut staged = self;
        staged.live = false;
        if created {
            handle
                .hard_link(&staged.name, handle, name)
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        ToolError::StaleFile
                    } else {
                        ToolError::Io(error)
                    }
                })?;
            staged.dir.remove_file(&staged.name)?;
            Ok(())
        } else {
            handle
                .rename(&staged.name, handle, name)
                .map_err(ToolError::Io)
        }
    }
}
impl Drop for Staged {
    fn drop(&mut self) {
        if self.live {
            let _ = self.dir.remove_file(&self.name);
        }
    }
}

fn split(root: &Dir, path: &str) -> Result<(Dir, std::ffi::OsString), ToolError> {
    let parent = Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let handle = match parent {
        Some(parent) => root.open_dir(parent)?,
        None => root.try_clone()?,
    };
    let name = Path::new(path)
        .file_name()
        .ok_or(ToolError::InvalidInput)?
        .to_owned();
    Ok((handle, name))
}

/// Whole-patch transaction: all files are parsed, read, transformed and
/// staged before the first rename; a publish failure restores already
/// published files best-effort, mirroring the optimistic-CAS contract of the
/// single-file writers. Delete runs last because it is not restorable.
pub fn apply(root: &Dir, operations: &[Operation]) -> Result<Value, ToolError> {
    let mut plan: Vec<(Operation, Option<Staged>, Option<Vec<u8>>, Option<Vec<u8>>)> = Vec::new();
    for operation in operations {
        let original = read_original(root, &operation.path)?;
        let (staged, final_bytes) = match operation.action {
            Action::Add => {
                if original.is_some() {
                    return Err(ToolError::StaleFile);
                }
                let bytes = operation.content.clone().into_bytes();
                let (handle, _) = split(root, &operation.path)?;
                (Some(Staged::create(&handle, &bytes, None)?), Some(bytes))
            }
            Action::Update => {
                let original = original.clone().ok_or(ToolError::StaleFile)?;
                let (text, bom, crlf) = normalize(&original)?;
                let text = apply_hunks(&text, &operation.hunks)?;
                let bytes = restore(text, bom, crlf);
                if bytes.len() > MAX_FILE {
                    return Err(ToolError::InvalidFile);
                }
                let (handle, name) = split(root, &operation.path)?;
                let permissions = handle.metadata(&name).ok().map(|meta| meta.permissions());
                (
                    Some(Staged::create(&handle, &bytes, permissions)?),
                    Some(bytes),
                )
            }
            Action::Delete => {
                if original.is_none() {
                    return Err(ToolError::StaleFile);
                }
                (None, None)
            }
        };
        plan.push((operation.clone(), staged, original, final_bytes));
    }
    let mut published: Vec<(String, Option<Vec<u8>>)> = Vec::new();
    let mut files = Vec::new();
    for (operation, staged, original, final_bytes) in &mut plan {
        let Some(staged) = staged.take() else {
            continue;
        };
        let (handle, name) = split(root, &operation.path)?;
        let created = operation.action == Action::Add;
        if let Err(error) = staged.publish(&handle, &name, created) {
            rollback(root, &published);
            return Err(error);
        }
        published.push((operation.path.clone(), original.clone()));
        let bytes = final_bytes.clone().unwrap_or_default();
        files.push(json!({
            "path": operation.path,
            "action": operation.action.name(),
            "sha256": crate::permission::digest(&bytes),
            "bytes": bytes.len(),
        }));
    }
    for (operation, _, _, _) in plan.iter().filter(|(_, staged, _, _)| staged.is_none()) {
        match root.remove_file(&operation.path) {
            Ok(()) => files.push(json!({"path": operation.path, "action": "delete"})),
            Err(error) => {
                rollback(root, &published);
                return Err(error.into());
            }
        }
    }
    Ok(json!({"applied": true, "files": files, "count": files.len()}))
}

fn rollback(root: &Dir, published: &[(String, Option<Vec<u8>>)]) {
    for (path, original) in published.iter().rev() {
        let Ok((handle, name)) = split(root, path) else {
            continue;
        };
        if let Some(original) = original {
            if Staged::create(&handle, original, None)
                .and_then(|staged| staged.publish(&handle, &name, false))
                .is_err()
            {
                continue;
            }
        } else {
            let _ = handle.remove_file(&name);
        }
    }
}
