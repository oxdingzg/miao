use miao_engine::store::Store;
use std::fs;

async fn fixture() -> (tempfile::TempDir, Store, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("s", "fixture", workspace.to_str().unwrap())
        .await
        .unwrap();
    (dir, store, workspace)
}

#[tokio::test]
async fn stage_restores_touched_files_and_clear_undoes_it() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    store.record_file_touch("s", "a.txt").await.unwrap();
    let captured = store.capture_file_snapshot("s", 1).await.unwrap();
    assert_eq!(captured["available"], true);

    fs::write(workspace.join("a.txt"), "two").unwrap();
    fs::write(workspace.join("later.txt"), "later").unwrap();
    let staged = store.revert_stage("s", 1, true).await.unwrap();
    assert_eq!(staged["boundary_seq"], 1);
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "one");
    // A file that no snapshot recorded is not deleted.
    assert_eq!(
        fs::read_to_string(workspace.join("later.txt")).unwrap(),
        "later"
    );
    assert_eq!(store.staged_revert("s").await.unwrap()["boundary_seq"], 1);

    let cleared = store.revert_clear("s").await.unwrap();
    assert_eq!(cleared["boundary_seq"], 1);
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "two");
    assert!(store.staged_revert("s").await.unwrap().is_null());
    assert!(store.revert_clear("s").await.is_err());
}

#[tokio::test]
async fn commit_soft_reverts_and_leaves_no_stage() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    store.record_file_touch("s", "a.txt").await.unwrap();
    store.capture_file_snapshot("s", 1).await.unwrap();
    fs::write(workspace.join("a.txt"), "two").unwrap();
    store.revert_stage("s", 1, true).await.unwrap();
    let committed = store.revert_commit("s").await.unwrap();
    assert_eq!(committed["boundary_seq"], 1);
    assert!(store.staged_revert("s").await.unwrap().is_null());
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "one");
    assert!(store.revert_commit("s").await.is_err());
}

#[tokio::test]
async fn restore_refuses_escapes_and_missing_data() {
    let (_dir, store, workspace) = fixture().await;
    assert!(store.record_file_touch("s", "../outside").await.is_err());
    assert!(store.record_file_touch("s", "/absolute").await.is_err());

    fs::write(workspace.join("a.txt"), "one").unwrap();
    store.record_file_touch("s", "a.txt").await.unwrap();
    store.capture_file_snapshot("s", 1).await.unwrap();
    let blobs = workspace
        .parent()
        .unwrap()
        .join("engine.snapshots")
        .join("s");
    fs::remove_dir_all(blobs).unwrap();
    fs::write(workspace.join("a.txt"), "two").unwrap();
    let error = store.revert_stage("s", 1, true).await.unwrap_err();
    assert!(error.to_string().contains("no longer available"));
    // A failed restore leaves no staged intent.
    assert!(store.staged_revert("s").await.unwrap().is_null());
}

#[tokio::test]
async fn stage_requires_a_captured_boundary() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    assert!(store.revert_stage("s", 1, true).await.is_err());
}

#[tokio::test]
async fn a_history_only_stage_rewinds_a_session_that_never_touched_a_file() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "untouched").unwrap();
    // No capture exists, so a file revert has nothing to restore; the explicit
    // history-only stage still records the intent and commits.
    let staged = store.revert_stage("s", 1, false).await.unwrap();
    assert_eq!(staged["restored"], serde_json::json!([]));
    assert_eq!(staged["removed"], serde_json::json!([]));
    assert_eq!(
        fs::read_to_string(workspace.join("a.txt")).unwrap(),
        "untouched"
    );
    let committed = store.revert_commit("s").await.unwrap();
    assert_eq!(committed["boundary_seq"], 1);
    let snapshot = store.snapshot("s").await.unwrap();
    assert_eq!(snapshot["staged_revert"], serde_json::Value::Null);
    assert_eq!(snapshot["reverted_count"], 0);
}

#[tokio::test]
async fn preview_reports_the_file_plan_without_touching_the_workspace() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    fs::write(workspace.join("gone.txt"), "here").unwrap();
    fs::write(workspace.join("old.txt"), "stale").unwrap();
    fs::remove_file(workspace.join("old.txt")).unwrap();
    for path in ["a.txt", "gone.txt", "old.txt"] {
        store.record_file_touch("s", path).await.unwrap();
    }
    store.capture_file_snapshot("s", 1).await.unwrap();

    // This Session's own later work: a.txt rewritten, gone.txt deleted,
    // old.txt recreated.
    fs::write(workspace.join("a.txt"), "two").unwrap();
    fs::remove_file(workspace.join("gone.txt")).unwrap();
    fs::write(workspace.join("old.txt"), "fresh").unwrap();
    for path in ["a.txt", "gone.txt", "old.txt"] {
        store.record_file_touch("s", path).await.unwrap();
    }
    store.capture_file_snapshot("s", 4).await.unwrap();

    let preview = store.revert_preview("s", 1).await.unwrap();
    assert_eq!(preview["available"], true);
    assert_eq!(preview["boundary_seq"], 1);
    assert_eq!(preview["restore"], serde_json::json!(["a.txt", "gone.txt"]));
    assert_eq!(preview["remove"], serde_json::json!(["old.txt"]));
    // The current content is exactly what the Session last recorded, so no
    // path reads as an outside edit.
    assert_eq!(preview["conflicts"], serde_json::json!([]));
    // A preview is a read: the workspace and the stage are untouched.
    assert_eq!(fs::read_to_string(workspace.join("a.txt")).unwrap(), "two");
    assert!(store.staged_revert("s").await.unwrap().is_null());
}

#[tokio::test]
async fn preview_flags_a_path_that_changed_outside_the_session() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    store.record_file_touch("s", "a.txt").await.unwrap();
    store.capture_file_snapshot("s", 1).await.unwrap();
    // Something other than this Session rewrites the file after the capture.
    fs::write(workspace.join("a.txt"), "edited by hand").unwrap();
    let preview = store.revert_preview("s", 1).await.unwrap();
    assert_eq!(preview["restore"], serde_json::json!(["a.txt"]));
    assert_eq!(
        preview["conflicts"],
        serde_json::json!([{ "path": "a.txt", "action": "restore", "disk": "modified" }])
    );
    // A deletion outside the Session is a conflict too: restoring would
    // recreate a file the operator removed on purpose.
    fs::remove_file(workspace.join("a.txt")).unwrap();
    let preview = store.revert_preview("s", 1).await.unwrap();
    assert_eq!(
        preview["conflicts"],
        serde_json::json!([{ "path": "a.txt", "action": "restore", "disk": "missing" }])
    );
}

#[tokio::test]
async fn preview_says_when_a_boundary_has_no_file_record() {
    let (_dir, store, _workspace) = fixture().await;
    let preview = store.revert_preview("s", 1).await.unwrap();
    assert_eq!(preview["available"], false);
    assert_eq!(preview["reason"], "no-file-snapshot");
}

#[tokio::test]
async fn commit_reports_the_reverted_count_a_redo_can_rely_on() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    store.record_file_touch("s", "a.txt").await.unwrap();
    store.capture_file_snapshot("s", 1).await.unwrap();
    store
        .message("s", "user", serde_json::json!("first"))
        .await
        .unwrap();
    store
        .message("s", "assistant", serde_json::json!("answer"))
        .await
        .unwrap();
    store.revert_stage("s", 1, true).await.unwrap();
    let committed = store.revert_commit("s").await.unwrap();
    assert_eq!(committed["reverted"], 2);
    // The durable count is what a redo affordance reads: the soft-reverted
    // rows leave the projection but stay in the ledger until `unrevert`.
    assert_eq!(store.snapshot("s").await.unwrap()["reverted_count"], 2);
    store.unrevert("s").await.unwrap();
    assert_eq!(store.snapshot("s").await.unwrap()["reverted_count"], 0);
}
