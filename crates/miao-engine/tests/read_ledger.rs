use miao_engine::permission::digest;
use miao_engine::tools::Tools;
use serde_json::json;
use tokio_util::sync::CancellationToken;

async fn read(tools: &Tools, input: serde_json::Value) -> serde_json::Value {
    tools
        .execute("read_file", input, CancellationToken::new())
        .await
        .unwrap()
}

#[tokio::test]
async fn an_exact_repeat_of_unchanged_content_answers_with_the_fingerprint_not_the_payload() {
    let dir = tempfile::tempdir().unwrap();
    let body = "one\ntwo\nthree\n";
    std::fs::write(dir.path().join("data.txt"), body).unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    let first = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(first["text"], json!("one\ntwo\nthree\n"));
    assert_eq!(first["sha256"], json!(digest(body.as_bytes())));

    let again = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(again["unchanged"], json!(true));
    assert_eq!(again["sha256"], json!(digest(body.as_bytes())));
    assert_eq!(again["read"], json!(1));
    assert_eq!(again["bytes_saved"], json!(14));
    assert!(
        again.get("text").is_none(),
        "a duplicate delivery must not re-ship the payload"
    );
    assert!(again["note"].as_str().unwrap().contains("read 1"));
}

#[tokio::test]
async fn changed_content_reads_again_in_full() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("data.txt"), "old\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    let stale = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(stale["text"], json!("old\n"));

    std::fs::write(dir.path().join("data.txt"), "fresh\n").unwrap();
    let current = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(current["text"], json!("fresh\n"));
    assert!(current.get("unchanged").is_none());

    let ledger = tools.read_ledger();
    assert_eq!(ledger["reads"], json!(2));
    assert_eq!(ledger["duplicate_reads"], json!(0));
}

#[tokio::test]
async fn a_different_window_always_delivers_and_only_the_same_window_stubs() {
    let dir = tempfile::tempdir().unwrap();
    let body = "one\ntwo\nthree\nfour\n";
    std::fs::write(dir.path().join("data.txt"), body).unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    assert!(read(&tools, json!({"path":"data.txt"}))
        .await
        .get("text")
        .is_some());

    let window = read(&tools, json!({"path":"data.txt","offset":2,"limit":1})).await;
    assert_eq!(window["text"], json!("two"));

    let repeated = read(&tools, json!({"path":"data.txt","offset":2,"limit":1})).await;
    assert_eq!(repeated["unchanged"], json!(true));
    assert_eq!(repeated["read"], json!(2));

    // The default limit normalizes to 2000, so this is the same window twice.
    let first_default = read(&tools, json!({"path":"data.txt","offset":2,"limit":2000})).await;
    assert_eq!(first_default["text"], json!("two\nthree\nfour"));
    let second_default = read(&tools, json!({"path":"data.txt","offset":2})).await;
    assert_eq!(second_default["unchanged"], json!(true));

    let other = read(&tools, json!({"path":"data.txt","offset":3,"limit":1})).await;
    assert_eq!(other["text"], json!("three"));
    assert!(other.get("unchanged").is_none());
}

#[tokio::test]
async fn the_ledger_measures_what_a_task_paid_for_reads() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "alpha\nbeta\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    read(&tools, json!({"path":"a.txt"})).await;
    read(&tools, json!({"path":"b.txt"})).await;
    read(&tools, json!({"path":"a.txt","offset":1,"limit":1})).await;
    read(&tools, json!({"path":"a.txt"})).await;
    read(&tools, json!({"path":"b.txt"})).await;

    let ledger = tools.read_ledger();
    assert_eq!(ledger["reads"], json!(5));
    assert_eq!(ledger["duplicate_reads"], json!(2));
    assert_eq!(ledger["bytes_delivered"], json!(28));
    assert_eq!(ledger["bytes_saved"], json!(25));
    let mut deliveries: Vec<u64> = ledger["paths"]
        .as_object()
        .unwrap()
        .values()
        .map(|value| value.as_u64().unwrap())
        .collect();
    deliveries.sort_unstable();
    assert_eq!(deliveries, vec![1, 2]);
}

#[tokio::test]
async fn a_large_file_refuses_wholesale_and_still_deduplicates_windows() {
    let dir = tempfile::tempdir().unwrap();
    let body = (0..5000)
        .map(|index| format!("line {index}\n"))
        .collect::<String>();
    std::fs::write(dir.path().join("big.txt"), &body).unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    let whole = tools
        .execute(
            "read_file",
            json!({"path":"big.txt"}),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(whole.to_string().contains("offset"), "{whole}");

    let window = read(&tools, json!({"path":"big.txt","offset":100,"limit":3})).await;
    assert_eq!(window["text"], json!("line 99\nline 100\nline 101"));

    let repeated = read(&tools, json!({"path":"big.txt","offset":100,"limit":3})).await;
    assert_eq!(repeated["unchanged"], json!(true));

    let ledger = tools.read_ledger();
    assert_eq!(ledger["reads"], json!(2));
    assert_eq!(ledger["duplicate_reads"], json!(1));
}

#[tokio::test]
async fn sessions_do_not_inherit_each_others_deliveries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("data.txt"), "shared\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    let alice = tools.clone().with_read_scope("alice");
    let bob = tools.clone().with_read_scope("bob");

    let alice_first = read(&alice, json!({"path":"data.txt"})).await;
    assert_eq!(alice_first["text"], json!("shared\n"));

    let bob_first = read(&bob, json!({"path":"data.txt"})).await;
    assert_eq!(
        bob_first["text"],
        json!("shared\n"),
        "another session's read must never stub this one"
    );

    let alice_second = read(&alice, json!({"path":"data.txt"})).await;
    assert_eq!(alice_second["unchanged"], json!(true));

    let alice_ledger = alice.read_ledger();
    assert_eq!(alice_ledger["reads"], json!(2));
    assert_eq!(alice_ledger["duplicate_reads"], json!(1));
    let bob_ledger = bob.read_ledger();
    assert_eq!(bob_ledger["reads"], json!(1));
    assert_eq!(bob_ledger["duplicate_reads"], json!(0));
}

#[tokio::test]
async fn a_compaction_clears_the_scope_so_rereads_deliver_again() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("data.txt"), "FILE-CONTENT\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    read(&tools, json!({"path":"data.txt"})).await;
    let stubbed = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(stubbed["unchanged"], json!(true));

    tools.reset_read_ledger("");

    let after = read(&tools, json!({"path":"data.txt"})).await;
    assert_eq!(
        after["text"],
        json!("FILE-CONTENT\n"),
        "after the ledger reset the re-read carries the payload again"
    );
    let ledger = tools.read_ledger();
    assert_eq!(ledger["reads"], json!(3));
    assert_eq!(ledger["duplicate_reads"], json!(1));
}
