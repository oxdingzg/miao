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
    let staged = store.revert_stage("s", 1).await.unwrap();
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
    store.revert_stage("s", 1).await.unwrap();
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
    let error = store.revert_stage("s", 1).await.unwrap_err();
    assert!(error.to_string().contains("no longer available"));
    // A failed restore leaves no staged intent.
    assert!(store.staged_revert("s").await.unwrap().is_null());
}

#[tokio::test]
async fn stage_requires_a_captured_boundary() {
    let (_dir, store, workspace) = fixture().await;
    fs::write(workspace.join("a.txt"), "one").unwrap();
    assert!(store.revert_stage("s", 1).await.is_err());
}
