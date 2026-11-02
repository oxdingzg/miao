//! EXT-03 acceptance run (issue #2158). Numbers for the model-face reading of
//! "a large catalogue loads only the schemas it needs": what the provider
//! request carries before and after disclosure, and the discovery flow's
//! latency. Run with
//! `cargo test --release --test mcp_acceptance -- --nocapture`
//! and record the numbers on the issue.

use miao_engine::mcp::{Disclosure, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// A fake stdio MCP server serving `count` tools whose schemas are large
/// enough to be representative (nested properties, descriptions, required
/// lists — a few hundred bytes each).
async fn large_catalogue(
    count: usize,
) -> (
    Arc<Registry>,
    Arc<std::sync::atomic::AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let (client, server) = tokio::io::duplex(262144);
    let (read, mut write) = tokio::io::split(server);
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    let task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap() {
                "initialize" => {
                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"warehouse","version":"1"}})
                }
                "tools/list" => {
                    let tools: Vec<Value> = (0..count)
                        .map(|i| {
                            json!({
                                "name": format!("query_table_{i}"),
                                "description": format!("Run a warehouse query against table_{i}: filter rows, aggregate metrics, and return the materialized result set with column metadata."),
                                "inputSchema": {
                                    "type": "object",
                                    "properties": {
                                        "filter": {
                                            "type": "object",
                                            "properties": {
                                                "column": {"type": "string", "description": "Column to filter on"},
                                                "op": {"type": "string", "enum": ["eq","ne","gt","lt","like"]},
                                                "value": {"type": "string"}
                                            },
                                            "required": ["column", "op", "value"]
                                        },
                                        "aggregate": {
                                            "type": "object",
                                            "properties": {
                                                "fn": {"type": "string", "enum": ["count","sum","avg","min","max"]},
                                                "column": {"type": "string"}
                                            },
                                            "required": ["fn"]
                                        },
                                        "limit": {"type": "integer", "minimum": 1, "maximum": 10_000, "default": 100},
                                        "timeout_ms": {"type": "integer", "minimum": 100, "maximum": 60_000}
                                    },
                                    "required": ["filter"],
                                    "additionalProperties": false
                                }
                            })
                        })
                        .collect();
                    json!({"tools":tools})
                }
                "tools/call" => {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    json!({"content":[{"type":"text","text":"42 rows"}]})
                }
                other => panic!("unexpected MCP method {other}"),
            };
            write
                .write_all(
                    format!("{}\n", json!({"jsonrpc":"2.0","id":id,"result":result})).as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let (read, write) = tokio::io::split(client);
    let registry = Arc::new(
        Registry::connect_io("warehouse".into(), read, write)
            .await
            .unwrap(),
    );
    (registry, calls, task)
}

fn wire_bytes(tools: &[miao_engine::protocol::ToolDefinition]) -> usize {
    serde_json::to_vec(&tools).unwrap().len()
}

#[tokio::test]
async fn a_large_catalogue_discloses_two_tools_and_the_numbers_say_by_how_much() {
    let (registry, calls, task) = large_catalogue(120).await;

    let full = registry.definitions();
    let disclosed = registry.disclosed(Disclosure::Threshold(32), &[]);
    assert_eq!(full.len(), 120);
    assert_eq!(disclosed.len(), 2, "discovery pair only");
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "attach makes zero remote calls beyond tools/list"
    );

    // The discovery flow: search → detail → call, timed end to end.
    let started = std::time::Instant::now();
    let search = registry
        .call(
            "mcp_warehouse_search",
            json!({"query":"query_table_7","limit":50}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let search_ms = started.elapsed().as_millis_f64();
    let matches = search["matches"].as_array().unwrap();
    assert!(!matches.is_empty());
    let alias = matches[0]["name"].as_str().unwrap().to_string();

    let detail_started = std::time::Instant::now();
    let detail = registry
        .call(
            "mcp_warehouse_detail",
            json!({"tool": alias}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let detail_ms = detail_started.elapsed().as_millis_f64();
    assert!(
        detail["schema"].is_object()
            || detail["input_schema"].is_object()
            || detail.get("schema").is_some()
            || detail.get("inputSchema").is_some()
    );

    let call_started = std::time::Instant::now();
    let result = registry
        .call(
            &alias,
            json!({"filter":{"column":"id","op":"eq","value":"7"}}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let call_ms = call_started.elapsed().as_millis_f64();
    assert_eq!(result["content"][0]["text"], "42 rows");
    assert_eq!(
        calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "exactly one remote call"
    );

    let full_bytes = wire_bytes(&full);
    let disclosed_bytes = wire_bytes(&disclosed);
    println!(
        "[acceptance] catalogue tools={} full_surface_bytes={} disclosed_surface_bytes={} ratio={:.2}%",
        120,
        full_bytes,
        disclosed_bytes,
        disclosed_bytes as f64 / full_bytes as f64 * 100.0
    );
    println!(
        "[acceptance] discovery flow search={search_ms}ms detail={detail_ms}ms call={call_ms}ms total={:.2}ms",
        started.elapsed().as_millis_f64()
    );

    registry.shutdown().await;
    task.abort();
}
