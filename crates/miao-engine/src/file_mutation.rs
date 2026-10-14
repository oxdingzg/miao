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
pub(crate) fn apply(
    root: &Dir,
    relative: &Path,
    mutation: Mutation,
    snapshot: Option<String>,
) -> Result<Value, ToolError> {
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
    let current = original.as_ref().map(|bytes| digest(bytes));
    // A stale edit whose intent is unambiguous is rebased onto the current
    // content by unique context anchors before the failure is returned.
    let rebase = if current.as_deref() != expected.as_deref() {
        match (&mutation, snapshot.as_deref()) {
            (Mutation::Edit(v), Some(snapshot)) if !v.replace_all => {
                let text = match original.as_ref() {
                    Some(bytes) => {
                        std::str::from_utf8(bytes).map_err(|_| ToolError::InvalidFile)?
                    }
                    None => return Err(ToolError::StaleFile),
                };
                match crate::edit_recovery::recover(snapshot, text, &v.old_string, &v.new_string) {
                    crate::edit_recovery::Recovery::Recovered { replaced, note } => {
                        Some((replaced, note))
                    }
                    crate::edit_recovery::Recovery::Refused(reason) => {
                        return Err(ToolError::StaleEditRecovery(reason.as_str()))
                    }
                    crate::edit_recovery::Recovery::Inapplicable => {
                        return Err(ToolError::StaleFile)
                    }
                }
            }
            _ => return Err(ToolError::StaleFile),
        }
    } else {
        None
    };
    // The digest of the drift the rebase read, kept for the result payload;
    // the post-write read below must not shadow it.
    let drift = current;
    // A rebased edit is committed against the drift it read, so the final
    // compare-and-swap still rejects a concurrent external write.
    let expected = if rebase.is_some() {
        drift.clone()
    } else {
        expected
    };
    let text = match (&rebase, mutation) {
        (Some((replaced, _)), _) => replaced.clone(),
        (None, Mutation::Write(v)) => v.text,
        (None, Mutation::Edit(v)) => {
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
    let (committed, _) = read(&parent, Path::new(name))?;
    if committed.as_ref().map(|bytes| digest(bytes)).as_deref() != expected.as_deref() {
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
    // Dir may be an O_PATH capability on Linux; open a readable directory FD
    // for fsync instead. After publication an fsync failure is a durability
    // warning about an applied write, never a pre-effect retryable failure.
    #[cfg(unix)]
    let durability_error = parent
        .open(".")
        .and_then(|file| file.sync_all())
        .err()
        .map(|error| error.to_string());
    #[cfg(not(unix))]
    let durability_error: Option<String> = None;
    let durability = if durability_error.is_some() {
        "unknown"
    } else if cfg!(unix) {
        "synced"
    } else {
        "file_synced"
    };
    let mut result = json!({"sha256":digest(text.as_bytes()),"bytes":text.len(),"applied":true,"durability":durability,"durability_error":durability_error});
    if let Some((_, note)) = rebase {
        // The diff the model gets must show the rebase and the drift it
        // replaced, not just the requested span.
        result["rebased"] = json!(true);
        result["note"] = json!(note);
        result["previous_sha256"] = json!(drift);
    }
    Ok(result)
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
