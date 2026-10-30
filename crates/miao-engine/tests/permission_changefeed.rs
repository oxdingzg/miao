use miao_engine::{
    permission::Decision,
    permission_changefeed::{Cursor, Input, Scope},
    permission_project::Authority,
    permission_rules::Rule,
};

fn allow(resource: &str) -> Rule {
    Rule {
        action: "read".into(),
        resource: resource.into(),
        effect: Decision::Allow,
    }
}
fn page(after: Cursor, limit: usize) -> Input {
    Input { after, limit }
}

#[tokio::test]
async fn independent_owners_replay_only_the_bound_project_and_directory_without_cursor_stalls() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("permissions.db");
    let first = Authority::open(&root).await.unwrap();
    let second = Authority::open(&root).await.unwrap();
    let project = first.project("project".into()).unwrap();
    let writer = second.project("project".into()).unwrap();
    let context = project.context(directory.path(), None).await.unwrap();
    let initial = context.observe().await.unwrap();
    writer.put(allow("project/**")).await.unwrap();
    second
        .project("foreign".into())
        .unwrap()
        .put(allow("foreign/**"))
        .await
        .unwrap();
    let other = tempfile::tempdir().unwrap();
    writer
        .context(other.path(), None)
        .await
        .unwrap()
        .put(allow("other/**"))
        .await
        .unwrap();
    writer
        .context(directory.path(), Some("explicit".into()))
        .await
        .unwrap()
        .put(allow("explicit/**"))
        .await
        .unwrap();
    writer
        .context(directory.path(), None)
        .await
        .unwrap()
        .put(allow("local/**"))
        .await
        .unwrap();
    let first_page = context
        .changes(page(initial.cursor.clone(), 1))
        .await
        .unwrap();
    assert!(first_page.has_more);
    assert_eq!(first_page.cursor.seq, 1);
    assert_eq!(first_page.changes[0].scope, Scope::Project);
    let last = context.changes(page(first_page.cursor, 1)).await.unwrap();
    assert!(!last.has_more);
    assert_eq!(last.cursor.seq, 5);
    assert_eq!(last.changes.len(), 1);
    assert_eq!(
        last.changes[0].scope,
        Scope::Directory {
            directory: directory
                .path()
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .into(),
            workspace_id: None,
        }
    );
    assert!(context
        .changes(page(last.cursor.clone(), 1))
        .await
        .unwrap()
        .changes
        .is_empty());
    let all = project.changes(page(initial.cursor, 256)).await.unwrap();
    assert_eq!(
        all.changes
            .iter()
            .map(|change| change.seq)
            .collect::<Vec<_>>(),
        vec![1, 3, 4, 5]
    );
    assert_eq!(all.cursor, last.cursor);
    assert!(all.changes.iter().all(|change| change.recorded_at_ms > 0));
    let fresh = context.observe().await.unwrap();
    assert_eq!(fresh.cursor, last.cursor);
    assert_eq!(fresh.snapshot.project.rules.len(), 1);
    assert_eq!(fresh.snapshot.patterns.len(), 1);
}

#[tokio::test]
async fn observations_and_cursors_share_one_snapshot_during_concurrent_writes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("permissions.db");
    let reader = Authority::open(&root)
        .await
        .unwrap()
        .project("p".into())
        .unwrap();
    let writer = Authority::open(&root)
        .await
        .unwrap()
        .project("p".into())
        .unwrap();
    let pending = tokio::spawn(async move {
        for index in 0..64 {
            writer.put(allow(&format!("file-{index}"))).await.unwrap();
        }
    });
    for _ in 0..40 {
        let observed = reader.observe().await.unwrap();
        assert_eq!(observed.snapshot.revision, observed.cursor.seq);
        assert_eq!(observed.snapshot.rules.len() as u64, observed.cursor.seq);
        let mut cursor = observed.cursor;
        loop {
            let changes = reader.changes(page(cursor.clone(), 7)).await.unwrap();
            for change in &changes.changes {
                assert!(change.seq > cursor.seq);
                assert_eq!(change.revision, change.seq);
            }
            cursor = changes.cursor;
            if !changes.has_more {
                break;
            }
        }
    }
    pending.await.unwrap();
    let observed = reader.observe().await.unwrap();
    assert_eq!(observed.snapshot.revision, 64);
    assert_eq!(observed.cursor.seq, 64);
}

#[tokio::test]
async fn idempotent_retries_failed_handoffs_and_missing_revokes_do_not_emit_changes() {
    let directory = tempfile::tempdir().unwrap();
    let authority = Authority::open(directory.path().join("permissions.db"))
        .await
        .unwrap();
    let project = authority.project("p".into()).unwrap();
    let start = project.observe().await.unwrap();
    let inserted = project.put(allow("file")).await.unwrap();
    project.put(allow("file")).await.unwrap();
    assert!(project
        .handoff(uuid::Uuid::new_v4().to_string(), vec![])
        .await
        .is_err());
    assert!(project.remove(inserted.rules[0].id.clone()).await.unwrap());
    assert!(!project.remove(inserted.rules[0].id.clone()).await.unwrap());
    let before = project.observe().await.unwrap();
    assert_eq!(before.cursor.seq, 2);
    project
        .handoff(before.cursor.authority.clone(), vec![])
        .await
        .unwrap();
    project
        .handoff(before.cursor.authority, vec![])
        .await
        .unwrap();
    let changes = project.changes(page(start.cursor, 256)).await.unwrap();
    assert_eq!(changes.changes.len(), 3);
    assert_eq!(changes.cursor.seq, 3);
}

#[tokio::test]
async fn actual_v2_upgrade_preserves_receipts_and_journals_already_prepared_older_writes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("permissions.db");
    let mut older = rusqlite::Connection::open(&root).unwrap();
    older
        .execute_batch(include_str!("fixtures/permission_project_v2.sql"))
        .unwrap();
    older.pragma_update(None, "journal_mode", "WAL").unwrap();
    let mut prepared = older
        .prepare(
            "UPDATE permission_project SET revision=revision+1 WHERE project='fixture-project'",
        )
        .unwrap();
    let project = Authority::open(&root)
        .await
        .unwrap()
        .project("fixture-project".into())
        .unwrap();
    let observed = project.observe().await.unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/permission_project_v2.json")).unwrap();
    assert_eq!(
        serde_json::to_value(&observed.snapshot).unwrap(),
        fixture["expected"]
    );
    assert_eq!(observed.cursor.seq, 0);
    prepared.execute([]).unwrap();
    drop(prepared);
    let changed = project
        .changes(page(observed.cursor.clone(), 10))
        .await
        .unwrap();
    assert_eq!(changed.changes.len(), 1);
    assert_eq!(changed.changes[0].revision, 4);
    assert_eq!(changed.cursor.seq, 1);
    let transaction = older.transaction().unwrap();
    transaction
        .execute(
            "UPDATE permission_project SET revision=revision+1 WHERE project='fixture-project'",
            [],
        )
        .unwrap();
    transaction.rollback().unwrap();
    assert!(project
        .changes(page(changed.cursor.clone(), 10))
        .await
        .unwrap()
        .changes
        .is_empty());
    assert!(older
        .execute("UPDATE permission_change SET revision=7", [])
        .is_err());
    assert!(older.execute("DELETE FROM permission_change", []).is_err());
    drop(project);
    let reopened = Authority::open(&root)
        .await
        .unwrap()
        .project("fixture-project".into())
        .unwrap();
    assert_eq!(reopened.observe().await.unwrap().cursor, changed.cursor);
    assert_eq!(
        older
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        5
    );
}

#[tokio::test]
async fn cursors_reject_a_replaced_root_future_offsets_and_invalid_pages() {
    let directory = tempfile::tempdir().unwrap();
    let first = Authority::open(directory.path().join("first.db"))
        .await
        .unwrap()
        .project("p".into())
        .unwrap();
    let second = Authority::open(directory.path().join("second.db"))
        .await
        .unwrap()
        .project("p".into())
        .unwrap();
    let initial = first.observe().await.unwrap();
    assert!(second
        .changes(page(initial.cursor.clone(), 1))
        .await
        .is_err());
    for limit in [0, 257, usize::MAX] {
        assert!(first
            .changes(page(initial.cursor.clone(), limit))
            .await
            .is_err());
    }
    for seq in [1, 9_007_199_254_740_992, u64::MAX] {
        assert!(first
            .changes(page(
                Cursor {
                    authority: initial.cursor.authority.clone(),
                    seq
                },
                1
            ))
            .await
            .is_err());
    }
}
