mod common;
use miao_engine::{
    gemini::Gemini,
    openai_responses::OpenAIResponses,
    protocol::{Delivery, Input},
    provider::Provider,
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn sse(events: Vec<Value>) -> String {
    events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect()
}
fn reasoning() -> Value {
    json!({"type":"reasoning","id":"rs-final","summary":[],"encrypted_content":"opaque-final","status":"completed"})
}
fn responses_prefix() -> Vec<Value> {
    vec![
        json!({"type":"response.created","response":{"id":"response"}}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs-final"}}),
        json!({"type":"response.output_item.done","output_index":0,"item":reasoning()}),
        json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","role":"assistant"}}),
        json!({"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"PARTIAL"}),
    ]
}
fn gemini_parts() -> Vec<Value> {
    vec![
        json!({"text":"private-thought","thought":true,"thoughtSignature":"signed-thought"}),
        json!({"text":"PARTIAL","thoughtSignature":"signed-text"}),
    ]
}
fn partial(backend: usize) -> String {
    if backend == 0 {
        let mut events = responses_prefix();
        events.push(json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"unexecuted","call_id":"unexecuted","name":"write_file","arguments":"private-unfinished-arguments"}}));
        return sse(events);
    }
    let mut parts = gemini_parts();
    parts.push(json!({"functionCall":{"name":"write_file","args":{"path":"private-unfinished-arguments","text":"never","expected_sha256":null}}}));
    sse(vec![
        json!({"candidates":[{"content":{"role":"model","parts":parts}}],"usageMetadata":{"promptTokenCount":2}}),
    ])
}
fn answer(backend: usize) -> String {
    if backend == 0 {
        return sse(vec![
            json!({"type":"response.created","response":{"id":"next"}}),
            json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"RECOVERED"}]}],"usage":{"input_tokens":3,"output_tokens":1}}}),
        ]);
    }
    sse(vec![
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":"RECOVERED"}]},"finishReason":"STOP"}]}),
    ])
}
async fn drive(backend: usize, url: String) -> (tempfile::TempDir, Runtime, Store) {
    let dir = tempfile::tempdir().unwrap();
    let provider: Arc<dyn Provider> = if backend == 0 {
        Arc::new(OpenAIResponses::new(url, "fixture".into(), "model".into()).unwrap())
    } else {
        Arc::new(
            Gemini::new(
                url.replace("/fixture", "/v1beta/models/model:streamGenerateContent"),
                "fixture".into(),
                "model".into(),
            )
            .unwrap(),
        )
    };
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let runtime = Runtime::new(
        store.clone(),
        provider,
        Tools::new(dir.path()).await.unwrap(),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "human".into(),
                prompt: "answer".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if store
                .events("s", 0, 1000)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (dir, runtime, store)
}

#[tokio::test]
async fn finalized_opaque_receipts_survive_real_transport_rejection_and_echo_exactly_without_unfinished_calls(
) {
    for backend in 0..2 {
        let (url, mut requests, peer) = common::endpoint_with_disconnects(vec![
            (200, partial(backend), true),
            (200, answer(backend), false),
        ])
        .await;
        let (_dir, runtime, store) = drive(backend, url).await;
        let events = store.events("s", 0, 1000).await.unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "completed"
        );
        assert!(!events.iter().any(|event| event.kind == "tool.planned"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "provider.recovery.continuation")
                .count(),
            1
        );
        assert!(events.iter().any(
            |event| event.kind == "provider.interrupted" && event.data["unexecuted_calls"] == 1
        ));
        let history = store.history("s").await.unwrap();
        assert_eq!(history[1].content[0]["type"], "provider_opaque");
        assert_eq!(history[1].content[0]["model"], "model");
        assert!(!serde_json::to_string(&history)
            .unwrap()
            .contains("private-unfinished-arguments"));
        assert_eq!(history.last().unwrap().content[0]["text"], "RECOVERED");
        peer.await.unwrap();
        let first = requests.recv().await.unwrap();
        let next = requests.recv().await.unwrap();
        assert_eq!(first["model"], next["model"]);
        if backend == 0 {
            assert!(next["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item == &reasoning()));
            assert!(events
                .iter()
                .find(|event| event.kind == "usage" && event.data["partial"] == true)
                .unwrap()
                .data["usage"]
                .is_null());
        } else {
            let model = next["contents"]
                .as_array()
                .unwrap()
                .iter()
                .find(|content| content["role"] == "model")
                .unwrap();
            assert_eq!(model["parts"], json!(gemini_parts()));
        }
        assert!(!next.to_string().contains("private-unfinished-arguments"));
        assert!(requests.recv().await.is_none());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn unfinished_opaque_and_unknown_hosted_effects_are_not_replayed() {
    let mut unfinished = responses_prefix();
    unfinished.remove(2);
    let mut orphaned = responses_prefix();
    orphaned.remove(2);
    orphaned.remove(1);
    orphaned.push(
        json!({"type":"response.reasoning_text.delta","output_index":0,"delta":"unfinished"}),
    );
    let mut incomplete = responses_prefix();
    incomplete[2]["item"]["status"] = json!("in_progress");
    let mut hosted = responses_prefix();
    hosted.push(json!({"type":"response.output_item.added","output_index":2,"item":{"type":"web_search_call","id":"hosted"}}));
    let mut unknown = responses_prefix();
    unknown.push(json!({"type":"response.future_hosted_action","sequence_number":42}));
    let mut refusal = responses_prefix();
    refusal.push(json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no"}]}}));
    let unsafe_gemini = vec![
        vec![json!({"text":"PARTIAL","thoughtSignature":""})],
        vec![
            json!({"text":"PARTIAL"}),
            json!({"text":"unfinished-thought","thought":true}),
        ],
        vec![
            json!({"text":"PARTIAL"}),
            json!({"functionCall":{"name":"read_file","args":{"path":"unknown"}},"thoughtSignature":"call-bound-signature"}),
        ],
        vec![
            json!({"text":"PARTIAL"}),
            json!({"codeExecutionResult":{"outcome":"OUTCOME_OK"}}),
        ],
    ];
    let cases = vec![
        (0, sse(unfinished)),
        (0, sse(orphaned)),
        (0, sse(incomplete)),
        (0, sse(hosted)),
        (0, sse(unknown)),
        (0, sse(refusal)),
    ]
    .into_iter()
    .chain(unsafe_gemini.into_iter().map(|parts| {
        (
            1,
            sse(vec![
                json!({"candidates":[{"content":{"role":"model","parts":parts}}]}),
            ]),
        )
    }));
    for (backend, body) in cases {
        let (url, mut requests, peer) =
            common::endpoint_with_disconnects(vec![(200, body, true)]).await;
        let (_dir, runtime, store) = drive(backend, url).await;
        let events = store.events("s", 0, 1000).await.unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "failed"
        );
        assert!(!events
            .iter()
            .any(|event| event.kind == "provider.recovery.continuation"
                || event.kind == "tool.planned"));
        peer.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn opaque_receipts_do_not_turn_clean_incomplete_eof_into_a_transport_retry() {
    for backend in 0..2 {
        let (url, mut requests, peer) = common::endpoint(vec![(200, partial(backend))]).await;
        let (_dir, runtime, store) = drive(backend, url).await;
        let events = store.events("s", 0, 1000).await.unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event.kind == "run.finished")
                .unwrap()
                .data["reason"],
            "failed"
        );
        assert!(!events
            .iter()
            .any(|event| event.kind == "provider.recovery.continuation"));
        peer.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
        runtime.shutdown().await;
    }
}
