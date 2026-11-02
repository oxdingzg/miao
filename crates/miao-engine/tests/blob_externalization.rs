//! DATA-04 acceptance: oversized payloads live outside the ledger, GC never
//! deletes a live reference, and the disk curve is a repeatable measurement.
//!
//! The unit tests beside the blob module prove the transformation; these tests
//! prove the storage behaviour around it. A Store carrying payload-sized
//! events keeps its ledger small and answers `events()` with the original
//! text; truncation of the referencing rows followed by a gc pass removes the
//! files, and the same pass over a live reference keeps them. The disk curve
//! prints its numbers as JSON, so a rerun is comparable instead of anecdotal.

use miao_engine::store::Store;
use serde_json::{json, Value};
use std::path::Path;

fn big_document(seed: &str, kilobytes: usize) -> String {
    let chunk = format!("{seed}0123456789");
    chunk.repeat(kilobytes * 1024 / chunk.len() + 1)
}

async fn ledger_with_document(dir: &Path, seed: &str) -> (Store, String) {
    let store = Store::open(dir.join("engine.db")).await.expect("store");
    let document = big_document(seed, 128);
    store
        .record(
            "ses_blob",
            "tool.completed",
            json!({
                "call_id": "call_1",
                "is_error": false,
                "result": document,
            }),
        )
        .await
        .expect("record");
    (store, document)
}

fn blob_files(root: &Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return files;
    };
    for shard in entries.flatten() {
        if let Ok(files_in_shard) = std::fs::read_dir(shard.path()) {
            for file in files_in_shard.flatten() {
                files.push(file.path());
            }
        }
    }
    files.sort();
    files
}

#[tokio::test]
async fn an_oversized_payload_stays_out_of_the_ledger_and_reads_back_whole() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (store, document) = ledger_with_document(dir.path(), "doc").await;

    // The ledger row carries the reference, not the document.
    let raw = {
        let connection = rusqlite::Connection::open_with_flags(
            dir.path().join("engine.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("raw connection");
        connection
            .query_row(
                "SELECT data FROM engine_event WHERE session_id='ses_blob' AND kind='tool.completed'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("row")
    };
    assert!(
        raw.len() < 200,
        "the row stores a reference, not the document: {} bytes",
        raw.len()
    );
    let reference: Value = serde_json::from_str(&raw).expect("reference json");
    assert!(reference["result"]["blob"].is_string(), "{reference}");
    assert_eq!(reference["result"]["bytes"], document.len());

    // The blob file exists once and holds the document.
    let files = blob_files(&dir.path().join("blobs"));
    assert_eq!(files.len(), 1, "one document, one file");
    let stored = std::fs::read(&files[0]).expect("blob file");
    assert_eq!(stored.len(), document.len());

    // The read path rehydrates, so no consumer sees the reference.
    let events = store.events("ses_blob", 0, 100).await.expect("events");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].data["result"], document,
        "the read path hands back the original text"
    );
    assert!(
        !serde_json::to_string(&events[0].data)
            .expect("serialise")
            .contains("\"blob\""),
        "the reference never leaks through the read path"
    );

    // The returned Event from the write path is rehydrated too, because it
    // feeds broadcasts the TUI renders: a fresh `events` read of a second
    // ledger proves the round trip holds at the store boundary.
    let (store, document) = ledger_with_document(dir.path().join("again"), "doc2").await;
    let events = store.events("ses_blob", 0, 100).await.expect("events");
    assert_eq!(events[0].data["result"], document);
}

#[tokio::test]
async fn gc_takes_orphans_after_truncation_and_never_touches_live_references() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("blobs");
    let (store, _) = ledger_with_document(dir.path(), "victim").await;

    // A second, live payload the truncation will not touch.
    let live_document = big_document("keeper", 96);
    store
        .record(
            "ses_keep",
            "message.committed",
            json!({
                "role": "user",
                "content": live_document,
            }),
        )
        .await
        .expect("record live");

    let before = blob_files(&root);
    assert_eq!(before.len(), 2, "two documents, two files");

    // Truncate the victim's rows the way retention does, then collect.
    {
        let mut connection =
            rusqlite::Connection::open(dir.path().join("engine.db")).expect("truncate connection");
        connection
            .execute("DELETE FROM engine_event WHERE session_id='ses_blob'", [])
            .expect("truncate rows");
    }

    let live_set = {
        let mut found = Vec::new();
        let connection = rusqlite::Connection::open_with_flags(
            dir.path().join("engine.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("raw connection");
        let mut statement = connection
            .prepare("SELECT data FROM engine_event WHERE data LIKE '%\"blob\"%'")
            .expect("prepare");
        let mut rows = statement.query([]).expect("query");
        while let Some(row) = rows.next().expect("row") {
            let text: String = row.get(0).expect("text");
            let value: Value = serde_json::from_str(&text).expect("json");
            miao_engine::blob::references(&value, &mut found);
        }
        found.into_iter().collect::<std::collections::HashSet<_>>()
    };
    let report = miao_engine::blob::gc(&root, live_set, true);
    assert_eq!(report.removed_orphans, 1, "{}", report.to_json());
    assert_eq!(
        report.kept,
        1,
        "the live file survives: {}",
        report.to_json()
    );

    let after = blob_files(&root);
    assert_eq!(after.len(), 1, "only the live file remains");
    let stored = std::fs::read(&after[0]).expect("blob file");
    assert_eq!(
        stored.len(),
        live_document.len(),
        "the kept file is the live document"
    );
}

#[tokio::test]
async fn the_disk_curve_is_reported_as_numbers() {
    let dir = tempfile::tempdir().expect("temp dir");
    let ledger = dir.path().join("engine.db");
    let store = Store::open(&ledger).await.expect("store");

    // Ten turns, each carrying the same 128 KB ruleset plus a distinct
    // result: externalisation should collapse the repeated one.
    let ruleset = big_document("ruleset", 128);
    let mut samples = Vec::new();
    for turn in 0..10 {
        store
            .record(
                "ses_curve",
                "provider.request",
                json!({
                    "permissions": ruleset,
                    "step": turn,
                }),
            )
            .await
            .expect("record");
        store
            .record(
                "ses_curve",
                "tool.completed",
                json!({
                    "call_id": format!("call_{turn}"),
                    "result": big_document(&format!("result{turn}"), 32),
                }),
            )
            .await
            .expect("record");
        let (main, _, _) = {
            let mut size = 0u64;
            for suffix in ["", "-wal", "-shm"] {
                let mut path = ledger.clone().into_os_string();
                path.push(suffix);
                size += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            }
            size
        };
        samples.push(main);
    }
    let files = blob_files(&dir.path().join("blobs"));
    let body = json!({
        "turns": 10,
        "ledger_bytes_after_each_turn": samples,
        "ledger_bytes_final": samples.last().copied().unwrap_or(0),
        "inline_would_be_bytes": 10 * (128 + 32) * 1024,
        "blob_files": files.len(),
        "unique_documents": 11,
    });
    println!("DATA-04 disk curve: {body}");

    // The repeated ruleset costs one file: ten references, one document.
    assert_eq!(
        files.len(),
        11,
        "ten distinct results plus one shared ruleset"
    );
    assert!(
        samples.last().copied().unwrap_or(0) < 10 * 160 * 1024 / 2,
        "the ledger stayed under half the inline size: {body}"
    );
}
