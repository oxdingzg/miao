use miao_engine::store::Store;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[tokio::test]
async fn startup_recovery_skips_sessions_with_a_live_lease() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    store
        .initialize("ses_owned", "owned", dir.path().to_str().unwrap())
        .await
        .unwrap();
    store.start_run("ses_owned", "run-live").await.unwrap();
    store.claim_session("ses_owned", 500).await.unwrap();
    // A fresh lease means another runtime owns this run; startup must not
    // interrupt it.
    assert!(store.recover().await.unwrap().is_empty());
    assert!(store.active_run("ses_owned").await.unwrap().is_some());
    // Once the owner is gone its lease expires and adoption is correct.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(store.recover().await.unwrap().len(), 1);
    assert!(store.active_run("ses_owned").await.unwrap().is_none());
    // Same-process reconciliation still cleans up its own run under a live lease.
    store.start_run("ses_owned", "run-local").await.unwrap();
    store.claim_session("ses_owned", 30_000).await.unwrap();
    assert_eq!(
        store
            .recover_session(Some("ses_owned"))
            .await
            .unwrap()
            .len(),
        1
    );
}

fn spawn_engine(db: &std::path::Path, workspace: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_miao-engine"))
        .args([
            "serve",
            "--db",
            db.to_str().unwrap(),
            "--workspace",
            workspace.to_str().unwrap(),
            "--model",
            "fixture",
            "--provider",
            "openai-chat",
            "--endpoint",
            "http://127.0.0.1:9/chat/completions",
            "--http",
            "127.0.0.1:0",
            "--http-token",
            "fixture-token",
        ])
        .env("OPENAI_API_KEY", "fixture-only")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait_ready(child: &mut Child) {
    use std::io::{BufRead, BufReader};
    let mut reader = BufReader::new(child.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut line = String::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "engine did not report its HTTP listener"
        );
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => panic!("engine exited before listening"),
            Ok(_) if line.contains("http listening on") => return,
            Ok(_) => {}
            Err(error) => panic!("read engine output: {error}"),
        }
    }
}

#[test]
fn a_second_process_can_open_the_same_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("engine.db");
    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let mut first = spawn_engine(&db, &workspace);
    wait_ready(&mut first);
    // The store is shared: a second runtime must not die with `Busy`.
    let mut second = spawn_engine(&db, &workspace);
    wait_ready(&mut second);
    assert!(
        first.try_wait().unwrap().is_none(),
        "the first runtime must keep serving"
    );
    assert!(
        second.try_wait().unwrap().is_none(),
        "the second runtime must keep serving"
    );
    let _ = first.kill();
    let _ = second.kill();
    let _ = first.wait();
    let _ = second.wait();
}
