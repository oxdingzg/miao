//! Content-addressed blob storage for oversized event payloads (DATA-04).
//!
//! A Session log inflates when one recorded fact carries a large document —
//! an attachment pasted into a prompt, a tool result whose text dwarfs its
//! metadata — and the ledger page cache and WAL pay for every replay of it.
//! Values past [`THRESHOLD`] move to a file named by their SHA-256 digest
//! under `<ledger dir>/blobs/<first two hex>/<digest>`, and the event carries
//! the reference `{"blob": "<digest>", "bytes": <n>}` in the value's place.
//! Identical documents therefore share one file, which is the point for the
//! metadata that repeats every turn: the real 1.2 GB ledger records the same
//! permission ruleset on thousands of provider requests.
//!
//! The write path externalises inside `append`, where the connection knows
//! its own ledger path; the read path rehydrates at the three assembly points
//! that hand an `Event` to a consumer (`events`, `latest_event`, export), so
//! no consumer ever sees a reference it did not ask about. SQL consumers that
//! reach into `data` with `json_extract` — cron scheduling, usage reads,
//! permission projections — only touch small fields, which stay inline by
//! construction. A missing blob file rehydrates as the reference itself:
//! a reader sees the fact that content was externalised rather than a
//! failed request, and the GC report names the hole.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// A string value larger than this lives in a blob file, not in the ledger.
/// Most event payloads stay under a few kilobytes; this only catches the
/// documents a turn actually carried.
pub const THRESHOLD: usize = 64 * 1024;

/// Deepest nesting the walk will follow. A payload deeper than this keeps its
/// inner values inline — a bounded walk cannot be turned into a stack blowout
/// by hostile input.
const MAX_DEPTH: usize = 8;

/// The blob directory beside one ledger.
pub fn root_for(db_path: &Path) -> PathBuf {
    match db_path.parent() {
        Some(parent) => parent.join("blobs"),
        None => PathBuf::from("blobs"),
    }
}

fn is_reference(value: &Value) -> Option<(&str, usize)> {
    let object = value.as_object()?;
    if object.len() != 2 {
        return None;
    }
    let digest = object.get("blob")?.as_str()?;
    let bytes = object.get("bytes")?.as_u64()?;
    let digest =
        (digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit())).then_some(digest)?;
    usize::try_from(bytes).ok().map(|bytes| (digest, bytes))
}

/// Store `bytes` under its digest and return the reference object. An existing
/// file with the same digest is left alone, so repeated payloads — the
/// permission ruleset, an unchanged instruction block — cost one file total.
fn put(root: &Path, bytes: &[u8]) -> std::io::Result<Value> {
    let digest = hex(&Sha256::digest(bytes));
    let dir = root.join(&digest[..2]);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&digest);
    if !path.exists() {
        // Write beside the final name and rename, so a crash never leaves a
        // half-written file under a digest a reader already trusts.
        let tmp = dir.join(format!("{digest}.tmp-{}", std::process::id()));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(serde_json::json!({"blob": digest, "bytes": bytes.len()}))
}

/// Rehydrate one reference, or leave it in place when the file is gone.
fn get(root: &Path, digest: &str) -> Option<Vec<u8>> {
    std::fs::read(root.join(&digest[..2]).join(digest)).ok()
}

/// Externalise every string value past the threshold, in place. The size gate
/// runs on the whole payload first, so the common small event pays one length
/// check and no walk.
pub fn externalize(value: &mut Value, root: &Path) -> std::io::Result<()> {
    if serde_json::to_string(value).map(|text| text.len())? <= THRESHOLD {
        return Ok(());
    }
    externalize_value(value, root, 0)
}

fn externalize_value(value: &mut Value, root: &Path, depth: usize) -> std::io::Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    match value {
        Value::String(text) if text.len() > THRESHOLD => {
            *value = put(root, text.as_bytes())?;
        }
        Value::Array(items) => {
            for item in items {
                externalize_value(item, root, depth + 1)?;
            }
        }
        Value::Object(map) if map.len() == 2 && is_reference(value).is_some() => {
            // Already a reference: re-externalising would hide the live file
            // behind a second digest of the reference JSON itself.
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                externalize_value(item, root, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Restore externalised values in place. A reference whose file is missing
/// stays a reference — the reader sees what happened instead of a failure.
pub fn rehydrate(value: &mut Value, root: &Path) {
    rehydrate_value(value, root, 0);
}

fn rehydrate_value(value: &mut Value, root: &Path, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                rehydrate_value(item, root, depth + 1);
            }
        }
        Value::Object(_) if is_reference(value).is_some() => {
            let (digest, _) = is_reference(value).expect("checked above");
            if let Some(text) = get(root, digest).and_then(|bytes| String::from_utf8(bytes).ok()) {
                *value = Value::String(text);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                rehydrate_value(item, root, depth + 1);
            }
        }
        _ => {}
    }
}

/// Every digest this value references.
pub fn references(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                references(item, into);
            }
        }
        Value::Object(map) => {
            if let Some((digest, _)) = is_reference(value) {
                into.push(digest.to_owned());
            }
            for item in map.values() {
                references(item, into);
            }
        }
        _ => {}
    }
}

/// Remove blob files nothing references. The live set is read from the same
/// connection the caller owns, so the scan and the ledger agree on one moment;
/// files written after the scan sit out the round and die on the next. With
/// `apply` false the walk only counts what it would remove, which is what the
/// dry run reports.
pub fn gc(root: &Path, live: std::collections::HashSet<String>, apply: bool) -> GcReport {
    let mut report = GcReport::default();
    let Ok(entries) = std::fs::read_dir(root) else {
        return report;
    };
    for shard in entries.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            if name.contains(".tmp-") {
                // A crash left a staging write behind; no reader can reach it.
                if apply {
                    let _ = std::fs::remove_file(file.path());
                }
                report.removed_tmp += 1;
                continue;
            }
            if !live.contains(&name) {
                let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
                if apply {
                    match std::fs::remove_file(file.path()) {
                        Ok(()) => {
                            report.removed_orphans += 1;
                            report.reclaimed_bytes += bytes;
                        }
                        Err(_) => report.failed += 1,
                    }
                } else {
                    report.removed_orphans += 1;
                    report.reclaimed_bytes += bytes;
                }
            } else {
                report.kept += 1;
            }
        }
    }
    report
}

#[derive(Default, Debug, Clone)]
pub struct GcReport {
    pub removed_orphans: u64,
    pub removed_tmp: u64,
    pub kept: u64,
    pub failed: u64,
    pub reclaimed_bytes: u64,
}

impl GcReport {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "removed_orphans": self.removed_orphans,
            "removed_tmp": self.removed_tmp,
            "kept": self.kept,
            "failed": self.failed,
            "reclaimed_bytes": self.reclaimed_bytes,
        })
    }
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("blobs");
        (dir, root)
    }

    #[test]
    fn a_small_value_passes_through_and_a_large_one_moves() {
        let (_dir, root) = temp_root();
        let mut small = serde_json::json!({"prompt": "hi"});
        externalize(&mut small, &root).expect("externalize");
        assert_eq!(small, serde_json::json!({"prompt": "hi"}));

        let big = "x".repeat(THRESHOLD + 1);
        let mut large = serde_json::json!({"content": big, "role": "assistant"});
        externalize(&mut large, &root).expect("externalize");
        assert!(
            large["content"].get("blob").is_some(),
            "the large value became a reference: {}",
            serde_json::to_string(&large["content"]).unwrap()
        );
        assert_eq!(large["role"], "assistant", "the small sibling stays inline");

        rehydrate(&mut large, &root);
        assert_eq!(large["content"], serde_json::Value::String(big));
    }

    #[test]
    fn identical_payloads_share_one_file() {
        let (_dir, root) = temp_root();
        let doc = "y".repeat(THRESHOLD + 10);
        for _ in 0..3 {
            let mut value = serde_json::json!({"permissions": doc});
            externalize(&mut value, &root).expect("externalize");
        }
        let files: Vec<_> =
            std::fs::read_dir(root.join(&hex(&Sha256::digest(doc.as_bytes()))[..2]))
                .expect("shard")
                .flatten()
                .collect();
        assert_eq!(files.len(), 1, "one document, one file");
    }

    #[test]
    fn a_missing_blob_file_leaves_the_reference_in_place() {
        let (_dir, root) = temp_root();
        let big = "z".repeat(THRESHOLD + 1);
        let mut value = serde_json::json!({"content": big});
        externalize(&mut value, &root).expect("externalize");
        let digest = value["content"]["blob"]
            .as_str()
            .expect("reference")
            .to_owned();
        std::fs::remove_file(root.join(&digest[..2]).join(&digest)).expect("remove blob");

        rehydrate(&mut value, &root);
        assert_eq!(
            value["content"]["blob"], digest,
            "the reader sees the fact, not a failure"
        );
    }

    #[test]
    fn gc_never_touches_a_live_reference_and_takes_orphans() {
        let (_dir, root) = temp_root();
        let mut kept = serde_json::json!({"content": "k".repeat(THRESHOLD + 1)});
        externalize(&mut kept, &root).expect("externalize");
        let mut dropped = serde_json::json!({"content": "d".repeat(THRESHOLD + 1)});
        externalize(&mut dropped, &root).expect("externalize");

        let mut live = Vec::new();
        references(&kept, &mut live);
        references(&dropped, &mut live);
        let live: std::collections::HashSet<String> = live.into_iter().collect();

        // Orphan only the dropped file: the live set excludes it, as it would
        // be after the referencing rows were truncated away.
        let mut only_kept = Vec::new();
        references(&kept, &mut only_kept);
        let dry = gc(&root, only_kept.iter().cloned().collect(), false);
        assert_eq!(
            dry.removed_orphans,
            1,
            "the plan names the orphan: {}",
            dry.to_json()
        );
        assert!(
            root.join(&only_kept[0][..2]).join(&only_kept[0]).exists(),
            "a dry run deletes nothing"
        );

        let report = gc(&root, only_kept.into_iter().collect(), true);
        assert_eq!(report.removed_orphans, 1, "{}", report.to_json());
        assert_eq!(
            report.kept,
            1,
            "the live file survives: {}",
            report.to_json()
        );
        assert_eq!(report.failed, 0);

        // The surviving file still rehydrates.
        rehydrate(&mut kept, &root);
        assert!(kept["content"].is_string());
        let _ = live;
    }

    #[test]
    fn a_reference_is_not_mistaken_for_plain_metadata() {
        let value = serde_json::json!({"blob": "note", "bytes": 3});
        assert!(
            is_reference(&value).is_none(),
            "short digest is not a reference"
        );
        let mut live = Vec::new();
        references(&value, &mut live);
        assert!(live.is_empty(), "a coincidental shape collects nothing");
    }
}
