//! Wall-clock measurement for the ADR-13 read batch (JOB-03).
//!
//! The behavioural guarantees live in `read_batch.rs`; this file only prints
//! the numbers recorded in `docs/measurements.md`. It is ignored by default:
//!
//! ```text
//! cargo test --release --test read_batch -- --ignored --nocapture
//! ```
//!
//! Both cells issue nine calls in one provider turn: the same eight
//! `read_file` calls plus the same single `write_file`. Only the position of
//! the write differs. A write ends the declared-read prefix, so the control
//! settles every read serially in request order; the batch cell admits all
//! eight reads together and settles them in the provider's call order
//! afterwards. Same reads, same write, same turn count, so the wall-clock
//! delta is the batch's own effect.
#![cfg(any(target_os = "macos", target_os = "linux"))]
use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Mode, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const FILES: [&str; 8] = [
    "a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt",
];
const ROUNDS: usize = 21;

/// One row of the fixture. `read_file` refuses an unranged read above 32 KiB,
/// so 1000 rows is the largest honest fixture.
const ROWS: usize = 1_000;

/// Emits the whole call schedule on the first turn, then a closing message.
struct Script {
    calls: Vec<Value>,
    turn: AtomicUsize,
}
#[async_trait]
impl Provider for Script {
    async fn stream(
        &self,
        _: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if self.turn.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(Reply {
                content: Value::Array(self.calls.clone()),
                usage: json!({}),
                needs_tools: true,
            });
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"tool_use","id":id,"name":name,"input":input})
}
fn read(name: &str) -> Value {
    call(&format!("r-{name}"), "read_file", json!({"path":name}))
}
fn reads() -> Vec<Value> {
    FILES.iter().map(|name| read(name)).collect()
}
fn write() -> Value {
    call(
        "w",
        "write_file",
        json!({"path":"written.txt","text":"x\n","expected_sha256":null}),
    )
}
fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: false,
        process_network: false,
        sandbox: false,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

/// Runs one drain and returns wall clock plus the ids the engine batched.
async fn run(parent: &Path, calls: Vec<Value>) -> (u128, Vec<String>, usize, usize) {
    let workspace = parent.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let tools = Tools::new(&workspace)
        .await
        .unwrap()
        .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into());
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Script {
            calls,
            turn: AtomicUsize::new(0),
        }),
        tools,
        policy(),
    )
    .await
    .unwrap();
    let started = Instant::now();
    runtime
        .admit(
            Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "execute".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let elapsed = started.elapsed().as_millis();
    // Read the batch receipt from the store: the progress stream races the
    // drain's final event on a fixture this fast.
    let batched = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "tool.parallel.started")
        .map(|event| {
            event.data["call_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    // A settlement that failed would measure the refusal path, not a read.
    let failures = store
        .events("s", 0, 1000)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "tool.completed" && event.data["is_error"] == true)
        .count();
    let results = store
        .history("s")
        .await
        .unwrap()
        .iter()
        .flat_map(|message| message.content.as_array().into_iter().flatten().cloned())
        .filter(|block| block["type"] == "tool_result")
        .count();
    runtime.shutdown().await;
    (elapsed, batched, results, failures)
}

/// Fresh workspace, fresh database, same fixture files for one cell.
async fn run_cell(
    cell: &Path,
    source: &Path,
    calls: Vec<Value>,
) -> (u128, Vec<String>, usize, usize) {
    std::fs::create_dir_all(cell.join("workspace")).unwrap();
    for name in FILES {
        std::fs::copy(source.join(name), cell.join("workspace").join(name)).unwrap();
    }
    run(cell, calls).await
}

fn median(mut values: Vec<u128>) -> u128 {
    values.sort_unstable();
    values[values.len() / 2]
}

#[tokio::test]
#[ignore = "measurement, not a regression test"]
async fn read_batch_wall_clock() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    let row = "x".repeat(31).to_owned() + "\n";
    let body = row.repeat(ROWS);
    for name in FILES {
        std::fs::write(source.join(name), &body).unwrap();
    }
    println!("{} read files of {} bytes each", FILES.len(), body.len());

    let single = vec![read("a.txt")];
    let batch = reads().into_iter().chain([write()]).collect::<Vec<_>>();
    let mut serial = reads();
    serial.insert(1, write());

    // Paired rounds: both cells run back to back and only their order swaps,
    // so drift between rounds cancels instead of inflating one cell.
    let mut single_times = Vec::new();
    let mut deltas = Vec::new();
    for round in 0..ROUNDS {
        let single_cell = dir.path().join(format!("single{round}"));
        let (elapsed, _, results, failures) = run_cell(&single_cell, &source, single.clone()).await;
        assert_eq!(results, 1, "single settled {results}");
        assert_eq!(failures, 0, "single settled {failures} failed tool calls");
        single_times.push(elapsed);
        let order = if round % 2 == 0 {
            [("batch", &batch), ("serial", &serial)]
        } else {
            [("serial", &serial), ("batch", &batch)]
        };
        let mut times = [0u128; 2];
        for (index, (label, calls)) in order.into_iter().enumerate() {
            let cell = dir.path().join(format!("{label}{round}"));
            let (elapsed, batched, results, failures) =
                run_cell(&cell, &source, calls.to_vec()).await;
            assert_eq!(results, 9, "{label} settled {results} tool results");
            assert_eq!(failures, 0, "{label} settled {failures} failed tool calls");
            if label == "batch" {
                // The receipt is the only proof the overlap path ran at all.
                assert_eq!(batched.len(), 8, "batch admitted {batched:?}");
            } else {
                assert!(batched.is_empty(), "control admitted a batch: {batched:?}");
            }
            times[index] = elapsed;
        }
        let (batch_time, serial_time) = if round % 2 == 0 {
            (times[0], times[1])
        } else {
            (times[1], times[0])
        };
        deltas.push(serial_time as i128 - batch_time as i128);
    }
    let single_median = median(single_times.clone());
    let mut sorted = deltas.clone();
    sorted.sort_unstable();
    println!("single median {single_median} ms {single_times:?}");
    println!(
        "paired delta (serial - batch) median {} ms, min {}, max {} over {} rounds",
        sorted[sorted.len() / 2],
        sorted[0],
        sorted[sorted.len() - 1],
        sorted.len()
    );
    println!("deltas {deltas:?}");
}
