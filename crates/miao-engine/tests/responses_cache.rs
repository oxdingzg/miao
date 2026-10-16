mod common;
use miao_engine::{
    credential::{Credential, Source},
    openai_responses::OpenAIResponses,
    protocol::{Message, ModelRequest},
    provider::Provider,
    responses_cache::{Contract, Mode, Profile, Retention},
};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn frame() -> String {
    format!(
        "data: {}\n\ndata: {}\n\n",
        json!({"type":"response.created","response":{"id":"r"}}),
        json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":1}}})
    )
}
fn request() -> ModelRequest {
    ModelRequest {
        system: "stable rules".into(),
        tools: vec![],
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type":"text","text":"question"}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
    }
}
fn contract(endpoint: &str) -> Contract {
    Contract::from_wire(
        &json!({"model":"m","endpoint":endpoint,"authentication":"api","profile":"breakpoints"})
            .to_string(),
    )
    .unwrap()
}

#[tokio::test]
async fn real_wire_contracts_preserve_defaults_and_do_not_cross_role_models() {
    let (url, mut captures, server) = common::endpoint(vec![(200, frame()); 6]).await;
    let base = OpenAIResponses::new(url.clone(), "fixture".into(), "m".into()).unwrap();
    let modern = base.clone().with_cache_contract(contract(&url)).unwrap();
    let same = modern.for_model("m").unwrap();
    let different = modern.for_model("other").unwrap();
    let mut disabled = contract(&url);
    disabled.mode = Mode::Disabled;
    let mut legacy = contract(&url);
    legacy.profile = Profile::Legacy;
    legacy.retention = Some(Retention::Day);
    let providers: Vec<Arc<dyn Provider>> = vec![
        Arc::new(base.clone()),
        Arc::new(modern),
        same,
        different,
        Arc::new(base.clone().with_cache_contract(disabled).unwrap()),
        Arc::new(base.with_cache_contract(legacy).unwrap()),
    ];
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    for provider in providers {
        provider
            .stream(request(), tx.clone(), CancellationToken::new())
            .await
            .unwrap();
    }
    drop(tx);
    drain.await.unwrap();
    let mut bodies = Vec::new();
    for _ in 0..6 {
        bodies.push(captures.recv().await.unwrap());
    }
    assert!(bodies[0].get("prompt_cache_options").is_none());
    assert_eq!(bodies[0]["instructions"], "stable rules");
    assert_eq!(
        bodies[1]["prompt_cache_options"],
        json!({"mode":"implicit"})
    );
    assert_eq!(bodies[1]["input"][0]["role"], "developer");
    assert_eq!(
        bodies[1]["input"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
        "explicit"
    );
    assert_eq!(bodies[1]["input"][1], bodies[0]["input"][0]);
    assert!(bodies[1].get("instructions").is_none());
    assert_eq!(
        bodies[1], bodies[2],
        "same-model roles retain their validated contract"
    );
    assert_eq!(bodies[3]["model"], "other");
    assert!(bodies[3].get("prompt_cache_options").is_none());
    assert_eq!(bodies[3]["instructions"], "stable rules");
    assert_eq!(
        bodies[4]["prompt_cache_options"],
        json!({"mode":"explicit"})
    );
    assert_eq!(bodies[4]["input"], bodies[0]["input"]);
    assert_eq!(bodies[5]["prompt_cache_retention"], "24h");
    assert!(bodies[5].get("prompt_cache_options").is_none());
    assert_eq!(bodies[5]["input"], bodies[0]["input"]);
    server.abort();
}

#[test]
fn routing_rejects_cross_protocol_and_authentication_contracts_before_network() {
    let policy = contract("https://api.example/responses");
    assert!(miao_engine::routing::build_with_cache(
        "anthropic",
        None,
        Source::Static(Credential::key("fixture".into())),
        "m".into(),
        false,
        Some(policy.clone())
    )
    .is_err());
    assert!(miao_engine::routing::build_with_cache(
        "subscription-responses",
        Some("https://api.example/responses"),
        Source::Static(Credential::token("fixture".into(), None)),
        "m".into(),
        false,
        Some(policy.clone())
    )
    .is_err());
    assert!(OpenAIResponses::new(
        "https://other.example/responses".into(),
        "fixture".into(),
        "m".into()
    )
    .unwrap()
    .with_cache_contract(policy)
    .is_err());
}

#[test]
fn cli_rejects_invalid_contracts_and_prewarm_defaults_without_provider_work() {
    let dir = tempfile::tempdir().unwrap();
    let mut prewarm = serde_json::to_value(contract("https://api.example/responses")).unwrap();
    prewarm["prewarm"] = json!(true);
    for (provider, raw, reason) in [
        ("openai-responses", prewarm, "prewarming"),
        (
            "anthropic",
            serde_json::to_value(contract("https://api.example/responses")).unwrap(),
            "unsupported",
        ),
    ] {
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_miao-engine"))
            .args(["serve", "--db"])
            .arg(dir.path().join(format!("{provider}.db")))
            .arg("--workspace")
            .arg(dir.path())
            .args([
                "--model",
                "m",
                "--provider",
                provider,
                "--responses-cache-contract",
            ])
            .arg(raw.to_string())
            .env("OPENAI_API_KEY", "fixture")
            .env("ANTHROPIC_API_KEY", "fixture")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(reason),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
