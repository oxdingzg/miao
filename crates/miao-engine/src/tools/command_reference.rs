use super::{digest, Access, Policy, Prepared, ToolError, Tools};
use base64::Engine;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub(super) async fn prepare(tools: &Tools, path: &str) -> Result<Prepared, ToolError> {
    let expanded = path.strip_prefix("~/").and_then(|tail| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|home| std::path::PathBuf::from(home).join(tail))
    });
    let path = expanded
        .as_ref()
        .map(|path| path.to_string_lossy())
        .unwrap_or_else(|| path.into());
    let path = path.as_ref();
    let target = tools.contained(path).await?;
    if tokio::fs::metadata(&target).await?.is_dir() {
        return tools
            .prepare("list_files", json!({"path":path,"limit":200}))
            .await;
    }
    tools
        .prepare("read_file", json!({"path":path,"offset":1,"limit":2000}))
        .await
}

/// A command reference captures an attachment, not a model read window. It
/// retains the prepared resource, bounded read gate and native policy ceiling.
pub(super) async fn read(
    tools: &Tools,
    prepared: Prepared,
    policy: &Policy,
    cancel: CancellationToken,
) -> Result<crate::protocol::Attachment, ToolError> {
    if !matches!(prepared.name(), "read_file" | "list_files") || prepared.access() != Access::Read {
        return Err(ToolError::InvalidInput);
    }
    let _lease = tokio::select! {_=cancel.cancelled()=>return Err(ToolError::Interrupted),lease=tools.gate.clone().read_owned()=>lease};
    let current = tools
        .prepare(prepared.name(), prepared.input().clone())
        .await?;
    if current.path != prepared.path || current.resource != prepared.resource {
        return Err(ToolError::ResourceChanged);
    }
    if policy
        .assess_input(
            prepared.name(),
            prepared.resource(),
            prepared.access(),
            Some(prepared.input()),
        )
        .0
        == crate::permission::Decision::Deny
    {
        return Err(ToolError::External(
            "command reference was denied by policy".into(),
        ));
    }
    let metadata = tokio::fs::metadata(&prepared.path).await?;
    let bytes = if metadata.is_dir() {
        let mut directory = tokio::fs::read_dir(&prepared.path).await?;
        let mut names = Vec::new();
        let mut truncated = false;
        while let Some(entry) = directory.next_entry().await? {
            if names.len() == 200 {
                truncated = true;
                break;
            }
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        let mut text = names.join("\n");
        if truncated {
            text.push_str("\n[listing truncated]");
        }
        text.into_bytes()
    } else {
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return Err(ToolError::External(
                "command attachment must be a regular file of at most one MiB".into(),
            ));
        }
        let mut bytes = Vec::new();
        tokio::fs::File::open(&prepared.path)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 1024 * 1024 {
            return Err(ToolError::External(
                "command attachment grew beyond one MiB".into(),
            ));
        }
        bytes
    };
    let mime = mime(&bytes)
        .ok_or_else(|| ToolError::External("unsupported command attachment content".into()))?;
    let attachment = crate::protocol::Attachment {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        metadata: Some(serde_json::Map::from_iter([
            ("name".into(), prepared.input()["path"].clone()),
            ("path".into(), json!(prepared.path)),
            ("sha256".into(), json!(digest(&bytes))),
        ])),
    };
    attachment
        .validate()
        .map_err(|error| ToolError::External(error.to_string()))?;
    Ok(attachment)
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    if !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() {
        return Some("text/plain");
    }
    None
}
