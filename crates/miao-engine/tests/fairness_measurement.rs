#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Stress numbers for the JOB-06 cross-session fair pools: queue latency,
//! starvation, RSS, and the file-descriptor curve. Ignored by default:
//!
//! ```text
//! cargo test --release --test fairness_measurement -- --ignored --nocapture
//! ```
//!
//! A hog Session fills its two-slot share with long jobs; four worker
//! Sessions then each admit three short jobs into the shared four-slot pool.
//! The runtime's own queue accounting and the process RSS/fd count are
//! sampled while it runs, and every worker job must complete.
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
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Submitter;
#[async_trait]
impl Provider for Submitter {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            let prompt = request.messages[0].content[0]["text"]
                .as_str()
                .unwrap_or_default();
            if let Some(count) = prompt.strip_prefix("jobs ") {
                let long = prompt.contains("long");
                let count = count.split_whitespace().next().unwrap();
                let seconds = if long { 600 } else { 2 };
                let calls = (0..count.parse::<usize>().unwrap())
                    .map(|index| {
                        json!({"type":"tool_use","id":format!("call_{index}"),"name":"start_job","input":{
                            "argv":["/bin/sh","-c",format!("sleep {seconds}; printf result")],
                            "timeout_ms":10000
                        }})
                    })
                    .collect::<Vec<_>>();
                return Ok(Reply {
                    content: Value::Array(calls),
                    usage: json!({}),
                    needs_tools: true,
                });
            }
        }
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

fn policy() -> Policy {
    Policy::new(Config {
        mode: Mode::Workspace,
        allow_process: true,
        allow_background: true,
        rules: vec![Rule {
            tool: "*".into(),
            path: "**".into(),
            decision: Decision::Allow,
        }],
        ..Config::default()
    })
    .unwrap()
}

async fn setup(parent: &Path) -> (Runtime, Store) {
    let root = parent.join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("AGENTS.md"), "Preserve user changes.").unwrap();
    let store = Store::open(parent.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Submitter),
        Tools::new(root)
            .await
            .unwrap()
            .with_process_runner(env!("CARGO_BIN_EXE_miao-engine").into()),
        policy(),
    )
    .await
    .unwrap();
    (runtime, store)
}

fn input(session: &str, prompt: &str) -> Input {
    Input {
        agent_references: Default::default(),
        command: None,
        session_id: session.into(),
        input_id: session.into(),
        prompt: prompt.into(),
        delivery: Delivery::Steer,
    }
}

fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn fd_count() -> Option<usize> {
    Some(std::fs::read_dir("/proc/self/fd").ok()?.count())
}

#[tokio::test]
#[ignore]
async fn stress_curve_for_the_fair_job_pool() {
    let dir = tempfile::tempdir().unwrap();
    let (runtime, store) = setup(dir.path()).await;
    runtime
        .admit(input("hog", "jobs 2 long"), true)
        .await
        .unwrap();
    for index in 0..4 {
        runtime
            .admit(input(&format!("worker-{index}"), "jobs 3"), true)
            .await
            .unwrap();
    }

    let samples: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sampler_rows = samples.clone();
    let sampler_runtime = runtime.clone();
    let sampler = tokio::spawn(async move {
        loop {
            let snapshot = sampler_runtime.resources().await;
            sampler_rows.lock().unwrap().push(json!({
                "rss_kb": rss_kb(),
                "fds": fd_count(),
                "jobs": snapshot["jobs"],
            }));
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    });

    let started = std::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        loop {
            let mut settled = 0usize;
            for index in 0..4 {
                let session = format!("worker-{index}");
                let batch = store.jobs(&session).await.unwrap();
                let done = batch.len() == 3 && batch.iter().all(|job| job["state"] == "completed");
                if done {
                    settled += 1;
                }
            }
            if settled == 4 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("every worker Session's jobs complete while the hog holds its share");

    sampler.abort();
    let final_snapshot = runtime.resources().await;
    let (sample_count, peak_queued, rss, fds) = {
        let rows = samples.lock().unwrap();
        let peak_queued = rows
            .iter()
            .filter_map(|row| row["jobs"]["queued"].as_u64())
            .max()
            .unwrap_or(0);
        let rss = rows
            .iter()
            .filter_map(|row| row["rss_kb"].as_u64())
            .collect::<Vec<_>>();
        let fds = rows
            .iter()
            .filter_map(|row| row["fds"].as_u64())
            .collect::<Vec<_>>();
        (rows.len(), peak_queued, rss, fds)
    };
    println!("samples: {sample_count}");
    println!("wall_ms: {}", started.elapsed().as_millis());
    println!("peak_queued: {peak_queued}");
    println!(
        "queue_wait_max_ms: {}",
        final_snapshot["jobs"]["queue_wait_max_ms"]
    );
    println!(
        "rss_kb: {}..{}",
        rss.iter().min().unwrap_or(&0),
        rss.iter().max().unwrap_or(&0)
    );
    println!(
        "fds: {}..{}",
        fds.iter().min().unwrap_or(&0),
        fds.iter().max().unwrap_or(&0)
    );
    assert_eq!(
        final_snapshot["jobs"]["active"].as_u64().unwrap_or(99),
        2,
        "only the hog's share remains running: {final_snapshot}"
    );
    runtime.shutdown().await;
}
