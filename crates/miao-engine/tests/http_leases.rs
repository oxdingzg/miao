use miao_engine::{openai_chat::OpenAIChat, runtime::Runtime, store::Store, tools::Tools};
use serde_json::json;
use std::{sync::Arc, time::Duration};

const TOKEN: &str = "lease-fixture";

async fn runtime() -> (Runtime, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(
        Store::open(dir.path().join("engine.db")).await.unwrap(),
        Arc::new(
            OpenAIChat::new(
                "http://127.0.0.1:1".into(),
                "fixture".into(),
                "fixture".into(),
            )
            .unwrap(),
        ),
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    (runtime, dir)
}

async fn serve(
    runtime: &Runtime,
    idle: Duration,
) -> (String, tokio::task::JoinHandle<std::io::Result<()>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(miao_engine::http::serve_with_idle_timeout(
        runtime.clone(),
        listener,
        TOKEN.into(),
        Some(idle),
    ));
    (format!("http://{address}"), task)
}

async fn lease(client: &reqwest::Client, url: &str, id: &str, release: bool) {
    let response = client
        .post(format!("{url}/lease"))
        .bearer_auth(TOKEN)
        .json(&json!({"client_id":id,"release":release}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn one_window_detaching_does_not_stop_another_window() {
    let (runtime, _dir) = runtime().await;
    let (url, task) = serve(&runtime, Duration::from_millis(600)).await;
    let client = reqwest::Client::new();
    lease(&client, &url, "first", false).await;
    lease(&client, &url, "second", false).await;
    let renew_client = client.clone();
    let renew_url = url.clone();
    let heartbeat = tokio::spawn(async move {
        loop {
            lease(&renew_client, &renew_url, "second", false).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    lease(&client, &url, "first", true).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!task.is_finished());
    heartbeat.abort();
    let _ = heartbeat.await;
    lease(&client, &url, "second", true).await;
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn unauthenticated_or_invalid_clients_cannot_keep_an_idle_engine_alive() {
    let (runtime, _dir) = runtime().await;
    let (url, task) = serve(&runtime, Duration::from_millis(300)).await;
    let client = reqwest::Client::new();
    let denied = client
        .post(format!("{url}/lease"))
        .json(&json!({"client_id":"blocked"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    let invalid = client
        .post(format!("{url}/lease"))
        .bearer_auth(TOKEN)
        .json(&json!({"client_id":"../../bad"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 400);
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn running_work_outlives_all_ui_leases() {
    let (runtime, _dir) = runtime().await;
    runtime.initialize("s", "running").await.unwrap();
    runtime.store().start_run("s", "run").await.unwrap();
    let (_url, task) = serve(&runtime, Duration::from_millis(200)).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!task.is_finished());
    runtime
        .store()
        .finish_run("s", "run", "completed")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    runtime.shutdown().await;
}

#[tokio::test]
async fn idle_shutdown_closes_existing_event_streams() {
    let (runtime, _dir) = runtime().await;
    runtime.initialize("s", "events").await.unwrap();
    let (url, task) = serve(&runtime, Duration::from_millis(300)).await;
    let response = reqwest::Client::new()
        .get(format!("{url}/events?session_id=s"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(response);
    runtime.shutdown().await;
}
