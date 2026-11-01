//! Drive the in-process engine without a terminal: build the Runtime exactly
//! as `miao-engine serve` would, admit one prompt, and let the turn run.

use miao_tui::transport::Connection;
use serde_json::json;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let configured = miao_engine::cli::configure(&args)
        .await
        .map_err(|error| format!("configure: {error}"))?;
    let (mut connection, _events) =
        Connection::start_embedded(configured.runtime, Duration::from_secs(120))?;
    let client = connection
        .connect()
        .await
        .map_err(|error| format!("connect: {error}"))?;
    let session = format!("ses_{}", "a".repeat(64));
    client.initialize(&session, "probe").await?;
    client.subscribe(&session, 0).await?;
    let admitted = client
        .admit(
            json!({
                "session_id": session,
                "input_id": "inp_probe_1",
                "prompt": "回答两个字：你好",
            }),
            false,
            Vec::new(),
        )
        .await?;
    println!("admit: {}", serde_json::to_string(&admitted).unwrap_or_default());
    // Admission only queues the input (`delivery: steer`); the drain that runs
    // the model turn starts on `resume`.
    let resumed = client.request("resume", json!({ "session_id": &session })).await?;
    println!("resume: {}", serde_json::to_string(&resumed).unwrap_or_default());
    tokio::time::sleep(Duration::from_secs(40)).await;
    println!("done");
    Ok(())
}
