use crate::{permission::digest, tools::ToolError};
use cap_std::fs::{Dir, OpenOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteInput {
    pub path: String,
    pub text: String,
    pub expected_sha256: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditInput {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    pub expected_sha256: String,
    #[serde(default)]
    pub replace_all: bool,
}

pub(crate) enum Mutation {
    Write(WriteInput),
    Edit(EditInput),
}
impl Mutation {
    pub fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        let mutation = match name {
            "write_file" => {
                Self::Write(serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?)
            }
            "edit_file" => {
                Self::Edit(serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?)
            }
            _ => return Err(ToolError::Unsupported),
        };
        let hash = match &mutation {
            Self::Write(v) => v.expected_sha256.as_deref(),
            Self::Edit(v) => Some(v.expected_sha256.as_str()),
        };
        if hash.is_some_and(|h| {
            h.len() != 64
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(ToolError::InvalidInput);
        }
        match &mutation {
            Self::Write(v) if v.text.len() > 32768 => return Err(ToolError::InvalidInput),
            Self::Edit(v)
                if v.old_string.is_empty()
                    || v.old_string.len() > 32768
                    || v.new_string.len() > 32768 =>
            {
                return Err(ToolError::InvalidInput)
            }
            _ => {}
        }
        Ok(mutation)
    }
    pub fn path(&self) -> &str {
        match self {
            Self::Write(v) => &v.path,
            Self::Edit(v) => &v.path,
        }
    }
}

/// Own a newly created staging file only; never remove a preexisting file on
/// a create_new failure. All operations stay relative to the directory handle.
struct Staged<'a> {
    dir: &'a Dir,
    name: String,
}
impl Drop for Staged<'_> {
    fn drop(&mut self) {
        let _ = self.dir.remove_file(&self.name);
    }
}

/// Blocking commit section: callers must join it even when cancellation arrives.
/// Engine writers serialize externally. Existing-file checks are optimistic
/// against non-cooperating external writers, not a universal filesystem CAS.
pub(crate) fn apply(root: &Dir, relative: &Path, mutation: Mutation) -> Result<Value, ToolError> {
    let parent_path = relative
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = relative.file_name().ok_or(ToolError::InvalidInput)?;
    let parent = root.open_dir(parent_path)?;
    let (original, permissions) = read(&parent, Path::new(name))?;
    let expected = match &mutation {
        Mutation::Write(v) => v.expected_sha256.clone(),
        Mutation::Edit(v) => Some(v.expected_sha256.clone()),
    };
    if original.as_ref().map(|bytes| digest(bytes)).as_deref() != expected.as_deref() {
        return Err(ToolError::StaleFile);
    }
    let text = match mutation {
        Mutation::Write(v) => v.text,
        Mutation::Edit(v) => {
            let text = String::from_utf8(original.as_ref().ok_or(ToolError::StaleFile)?.clone())
                .map_err(|_| ToolError::InvalidFile)?;
            let count = text.matches(&v.old_string).count();
            if count == 0 || (!v.replace_all && count != 1) {
                return Err(ToolError::AmbiguousEdit);
            }
            if v.replace_all {
                text.replace(&v.old_string, &v.new_string)
            } else {
                text.replacen(&v.old_string, &v.new_string, 1)
            }
        }
    };
    if text.len() > 32768 {
        return Err(ToolError::InvalidFile);
    }
    let temporary = format!(".miao-engine-{}.tmp", uuid::Uuid::new_v4());
    let mut file = parent.open_with(&temporary, OpenOptions::new().write(true).create_new(true))?;
    let staged = Staged {
        dir: &parent,
        name: temporary,
    };
    file.write_all(text.as_bytes())?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    file.sync_all()?;
    drop(file);
    let (current, _) = read(&parent, Path::new(name))?;
    if current.as_ref().map(|bytes| digest(bytes)).as_deref() != expected.as_deref() {
        return Err(ToolError::StaleFile);
    }
    if original.is_none() {
        // Hard-link publication is atomic no-clobber, unlike exists+rename.
        parent.hard_link(&staged.name, &parent, name).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                ToolError::StaleFile
            } else {
                ToolError::Io(e)
            }
        })?;
        parent.remove_file(&staged.name)?;
    } else {
        parent.rename(&staged.name, &parent, name)?;
    }
    #[cfg(unix)]
    parent.try_clone()?.into_std_file().sync_all()?;
    Ok(json!({"sha256":digest(text.as_bytes()),"bytes":text.len()}))
}

fn read(
    parent: &Dir,
    name: &Path,
) -> Result<(Option<Vec<u8>>, Option<cap_std::fs::Permissions>), ToolError> {
    let metadata = match parent.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((None, None)),
        Err(e) => return Err(e.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32768 {
        return Err(ToolError::InvalidFile);
    }
    let permissions = metadata.permissions();
    let file = parent.open(name)?;
    let mut bytes = Vec::new();
    file.take(32769).read_to_end(&mut bytes)?;
    if bytes.len() > 32768 || std::str::from_utf8(&bytes).is_err() {
        return Err(ToolError::InvalidFile);
    }
    Ok((Some(bytes), Some(permissions)))
}
