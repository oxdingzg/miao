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
async fn a_line_window_returns_only_that_range_with_whole_file_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let body = "one\ntwo\nthree\nfour\n";
    std::fs::write(dir.path().join("data.txt"), body).unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();

    let window = read(&tools, json!({"path":"data.txt","offset":2,"limit":2})).await;
    assert_eq!(window["text"], json!("two\nthree"));
    assert_eq!(window["offset"], json!(2));
    assert_eq!(window["lines"], json!(2));
    assert_eq!(window["total_lines"], json!(4));
    assert_eq!(window["truncated"], json!(true));
    // The fingerprint always belongs to the whole file, so an edit can use it.
    assert_eq!(window["sha256"], json!(digest(body.as_bytes())));

    let tail = read(&tools, json!({"path":"data.txt","offset":4})).await;
    assert_eq!(tail["text"], json!("four"));
    assert_eq!(tail["truncated"], json!(false));

    let past_end = read(&tools, json!({"path":"data.txt","offset":99})).await;
    assert_eq!(past_end["text"], json!(""));
    assert_eq!(past_end["lines"], json!(0));
    assert_eq!(past_end["truncated"], json!(false));
}

#[tokio::test]
async fn a_large_file_is_readable_through_a_window_but_not_wholesale() {
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
        .await;
    assert!(whole.is_err(), "the whole-file path keeps its byte bound");

    let window = read(&tools, json!({"path":"big.txt","offset":100,"limit":3})).await;
    assert_eq!(window["text"], json!("line 99\nline 100\nline 101"));
    assert_eq!(window["total_lines"], json!(5000));
    assert_eq!(window["truncated"], json!(true));
}

#[tokio::test]
async fn zero_offset_or_limit_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("data.txt"), "one\n").unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    for input in [
        json!({"path":"data.txt","offset":0}),
        json!({"path":"data.txt","limit":0}),
    ] {
        assert!(tools
            .execute("read_file", input, CancellationToken::new())
            .await
            .is_err());
    }
}
