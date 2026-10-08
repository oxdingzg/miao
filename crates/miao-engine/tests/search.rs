use async_trait::async_trait;
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Searcher {
    name: String,
    input: Value,
}
#[async_trait]
impl Provider for Searcher {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"call","name":self.name,"input":self.input}]),
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
async fn run(root: &std::path::Path, name: &str, input: Value, config: Config) -> Value {
    let store = Store::open(root.join("engine.db")).await.unwrap();
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Searcher {
            name: name.into(),
            input,
        }),
        Tools::new(root).await.unwrap(),
        Policy::new(config).unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: uuid::Uuid::new_v4().to_string(),
                prompt: "search".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|e| e.kind == "run.finished")
            {
                let history = store.history("s").await.unwrap();
                return serde_json::from_str(history[2].content[0]["content"].as_str().unwrap())
                    .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    result
}

#[tokio::test]
async fn glob_and_grep_return_workspace_paths_and_line_previews_without_shell() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/a.rs"), "first\r\nNeedle here\r\nlast").unwrap();
    std::fs::write(dir.path().join("plain.txt"), "not matched").unwrap();
    let glob = run(
        dir.path(),
        "glob",
        json!({"pattern":"src/**/*.rs"}),
        Config::default(),
    )
    .await;
    assert_eq!(glob["matches"][0]["path"], "src/a.rs");
    assert_eq!(glob["matches"].as_array().unwrap().len(), 1);
    // Independent databases avoid adopting the previous finished test history.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/a.rs"), "first\r\nNeedle here\r\nlast").unwrap();
    let grep = run(
        dir.path(),
        "grep",
        json!({"pattern":"needle","glob":"**/*.rs","case_sensitive":false}),
        Config::default(),
    )
    .await;
    assert_eq!(grep["matches"][0]["path"], "src/a.rs");
    assert_eq!(grep["matches"][0]["line"], 2);
    assert_eq!(grep["matches"][0]["text"], "Needle here");
}

#[tokio::test]
async fn denied_asked_symlink_and_engine_files_are_not_read_into_results() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("secret")).unwrap();
    std::fs::create_dir(dir.path().join("asked")).unwrap();
    std::fs::write(dir.path().join("public.txt"), "needle public").unwrap();
    std::fs::write(
        dir.path().join("secret/private.txt"),
        "needle PRIVATE_SENTINEL",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("asked/private.txt"),
        "needle ASKED_SENTINEL",
    )
    .unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(
        outside.path().join("outside.txt"),
        "needle OUTSIDE_SENTINEL",
    )
    .unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linkdir")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.txt"),
            dir.path().join("linkfile"),
        )
        .unwrap();
    }
    let config = Config {
        rules: vec![
            Rule {
                tool: "*".into(),
                path: "secret/**".into(),
                decision: Decision::Deny,
            },
            Rule {
                tool: "*".into(),
                path: "asked/**".into(),
                decision: Decision::Ask,
            },
        ],
        ..Config::default()
    };
    let result = run(
        dir.path(),
        "grep",
        json!({"pattern":"needle","include_hidden":true}),
        config,
    )
    .await;
    assert_eq!(result["matches"].as_array().unwrap().len(), 1, "{result}");
    assert_eq!(result["matches"][0]["path"], "public.txt");
    assert!(result["skipped_policy"].as_u64().unwrap() >= 2);
    for secret in [
        "PRIVATE_SENTINEL",
        "ASKED_SENTINEL",
        "OUTSIDE_SENTINEL",
        "engine.db",
    ] {
        assert!(!result.to_string().contains(secret));
    }
}

#[tokio::test]
async fn output_limits_report_partial_and_long_lines_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("file.txt"),
        (0..10)
            .map(|_| format!("needle {}\n", "x".repeat(1000)))
            .collect::<String>(),
    )
    .unwrap();
    let result = run(
        dir.path(),
        "grep",
        json!({"pattern":"needle","limit":2}),
        Config::default(),
    )
    .await;
    assert_eq!(result["matches"].as_array().unwrap().len(), 2);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["matches"][0]["line_truncated"], true);
    assert!(result["matches"][0]["text"].as_str().unwrap().len() <= 512);
}

#[tokio::test]
async fn invalid_regex_glob_scope_and_limits_fail_before_search() {
    for (name, input) in [
        ("grep", json!({"pattern":"["})),
        ("glob", json!({"pattern":"../**"})),
        ("glob", json!({"pattern":"**","path":".."})),
        ("grep", json!({"pattern":"a","limit":0})),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let result = run(dir.path(), name, input, Config::default()).await;
        assert!(result.get("error").is_some(), "{result}");
    }
}
