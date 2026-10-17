use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, Response},
    routing::any,
    Router,
};
use miao_engine::{
    approval::{Approval, Response as ApprovalResponse},
    protocol::{Delivery, Input, ModelRequest},
    provider::{Provider, ProviderError, Reply},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use miao_engine::{
    permission::{Config, Decision, Policy, Rule},
    tools::ToolError,
    web::{Client, SearchConfig, SearchProvider},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Page {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}
fn page(kind: &str, body: impl Into<Vec<u8>>) -> Page {
    Page {
        status: 200,
        headers: vec![("content-type", kind.into())],
        body: body.into(),
    }
}
async fn server(
    pages: Vec<(&str, Page)>,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let pages = Arc::new(
        pages
            .into_iter()
            .map(|(path, page)| (path.to_owned(), page))
            .collect::<HashMap<_, _>>(),
    );
    let (send, receive) = mpsc::channel(16);
    let app=Router::new().fallback(any(move |request:Request<Body>| {
        let pages=pages.clone(); let send=send.clone();
        async move {
            let (parts,body)=request.into_parts();
            let body=to_bytes(body,1024*1024).await.unwrap();
            send.send(json!({"path":parts.uri.path(),"key":parts.headers.get("x-api-key").and_then(|value|value.to_str().ok()),"body":serde_json::from_slice::<Value>(&body).ok()})).await.unwrap();
            let page=pages.get(parts.uri.path()).cloned().unwrap_or(Page { status:404,headers:vec![],body:vec![] });
            let mut response=Response::builder().status(page.status);
            for (name,value) in page.headers {response=response.header(name,value);}
            response.body(Body::from(page.body)).unwrap()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (address, receive, task)
}
fn policy(rules: Vec<Rule>) -> Policy {
    Policy::new(Config {
        allow_web: true,
        rules,
        ..Config::default()
    })
    .unwrap()
}
fn allow() -> Policy {
    policy(vec![Rule {
        tool: "*".into(),
        path: "@web/**".into(),
        decision: Decision::Allow,
    }])
}

#[tokio::test]
async fn fetch_renders_real_html_and_declared_text_encoding_and_bounds_output() {
    let (address,_seen,task)=server(vec![
        ("/html",page("Text/HTML; Charset=UTF-8","<html><head><title>hidden</title></head><body><h1>标题</h1><p>Hello <a href=\"https://example.org/\">world</a></p><script>do_not_include()</script></body></html>")),
        ("/gbk",page("text/plain; charset=gbk",vec![0xc4,0xe3,0xba,0xc3])),
        ("/large",page("text/plain","中".repeat(30000))),
        ("/oversized",page("text/plain",vec![b'x';2*1024*1024+1])),
    ]).await;
    let client = Client::new(None).unwrap();
    let markdown = client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/html#section")}),
            &allow(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(markdown["content"]
        .as_str()
        .unwrap()
        .contains("[world](https://example.org/)"));
    let text = client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/html"),"format":"text"}),
            &allow(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let text = text["content"].as_str().unwrap();
    assert!(text.contains("标题"));
    assert!(text.contains("Hello"));
    assert!(!text.contains("hidden"));
    assert!(!text.contains("do_not_include"));
    let encoded = client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/gbk")}),
            &allow(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(encoded["content"], "你好");
    let large = client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/large")}),
            &allow(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(large["content"].as_str().unwrap().len() <= 65536);
    assert_eq!(large["truncated"], true);
    assert!(client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/oversized")}),
            &allow(),
            CancellationToken::new()
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("exceeds 2 MiB"));
    task.abort();
}

#[tokio::test]
async fn redirects_are_reauthorized_and_denied_targets_receive_no_request() {
    let (address, mut seen, task) = server(vec![
        (
            "/redirect",
            Page {
                status: 302,
                headers: vec![("location", "/blocked".into())],
                body: vec![],
            },
        ),
        ("/blocked", page("text/plain", "must not be fetched")),
    ])
    .await;
    let client = Client::new(None).unwrap();
    let policy = policy(vec![
        Rule {
            tool: "webfetch".into(),
            path: "@web/**".into(),
            decision: Decision::Allow,
        },
        Rule {
            tool: "webfetch".into(),
            path: "**/blocked".into(),
            decision: Decision::Deny,
        },
    ]);
    let result = client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/redirect")}),
            &policy,
            CancellationToken::new(),
        )
        .await;
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("redirect requires separate permission"));
    assert_eq!(seen.recv().await.unwrap()["path"], "/redirect");
    assert!(seen.try_recv().is_err());
    assert!(client
        .execute(
            "webfetch",
            json!({"url":format!("{address}/blocked")}),
            &policy,
            CancellationToken::new()
        )
        .await
        .is_err());
    assert!(seen.try_recv().is_err());
    for target in [
        "file:///private/data",
        "ftp://example.org/",
        "https://user:password@example.org/",
    ] {
        assert!(matches!(
            client.prepare("webfetch", json!({"url":target})),
            Err(ToolError::InvalidInput)
        ));
    }
    task.abort();
}

#[tokio::test]
async fn searches_use_their_native_wire_contract_and_never_return_the_key() {
    for provider in [SearchProvider::Exa, SearchProvider::Parallel] {
        let response = match provider {
            SearchProvider::Exa => {
                json!({"results":[{"title":"Result","url":"https://example.org/","text":"中国abcdef"},{"url":"file:///private","text":"ignore"}]})
            }
            SearchProvider::Parallel => {
                json!({"search_id":"search_fixture","session_id":"session_fixture","results":[{"title":"Result","url":"https://example.org/","excerpts":["中国abcdef"]}]})
            }
        };
        let (address, mut seen, task) = server(vec![(
            "/search",
            page("application/json", response.to_string()),
        )])
        .await;
        let client = Client::new(Some(
            SearchConfig::new(provider, Some(&format!("{address}/search")), "fixture-key").unwrap(),
        ))
        .unwrap();
        let result = client
            .execute(
                "websearch",
                json!({"query":"test query","type":"fast","numResults":3,"contextMaxCharacters":4}),
                &allow(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["results"][0]["text"], "中国ab");
        assert_eq!(result["results"][0]["truncated"], true);
        assert!(!result.to_string().contains("fixture-key"));
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        let wire = seen.recv().await.unwrap();
        assert_eq!(wire["key"], "fixture-key");
        match provider {
            SearchProvider::Exa => {
                assert_eq!(wire["body"]["type"], "fast");
                assert_eq!(wire["body"]["query"], "test query");
                assert_eq!(wire["body"]["numResults"], 3);
            }
            SearchProvider::Parallel => {
                assert_eq!(wire["body"]["mode"], "fast");
                assert_eq!(wire["body"]["search_queries"], json!(["test query"]));
                assert_eq!(wire["body"]["advanced_settings"]["max_results"], 3);
            }
        }
        task.abort();
    }
}

#[tokio::test]
async fn search_redirects_never_forward_credentials_and_errors_hide_provider_bodies() {
    let (address, mut seen, task) = server(vec![
        (
            "/search",
            Page {
                status: 307,
                headers: vec![("location", "/steal".into())],
                body: vec![],
            },
        ),
        (
            "/denied",
            Page {
                status: 401,
                headers: vec![],
                body: b"secret upstream detail fixture-key".to_vec(),
            },
        ),
    ])
    .await;
    for (path, code) in [("search", 307), ("denied", 401)] {
        let client = Client::new(Some(
            SearchConfig::new(
                SearchProvider::Exa,
                Some(&format!("{address}/{path}")),
                "fixture-key",
            )
            .unwrap(),
        ))
        .unwrap();
        let error = client
            .execute(
                "websearch",
                json!({"query":"test"}),
                &allow(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(&format!("HTTP {code}")));
        assert!(!error.contains("fixture-key"));
        assert_eq!(seen.recv().await.unwrap()["path"], format!("/{path}"));
        assert!(seen.try_recv().is_err());
    }
    task.abort();
}

#[tokio::test]
async fn cancellation_drops_an_inflight_web_response() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/wait", listener.local_addr().unwrap());
    let (started, waiting) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        started.send(()).unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        drop(socket);
    });
    let client = Client::new(None).unwrap();
    let cancel = CancellationToken::new();
    let work = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            client
                .execute("webfetch", json!({"url":address}), &allow(), cancel)
                .await
        }
    });
    waiting.await.unwrap();
    cancel.cancel();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(1), work)
            .await
            .unwrap()
            .unwrap(),
        Err(ToolError::Interrupted)
    ));
    task.abort();
}

struct Fetcher {
    url: String,
}
#[async_trait]
impl Provider for Fetcher {
    async fn stream(
        &self,
        request: ModelRequest,
        _: mpsc::Sender<Value>,
        _: CancellationToken,
    ) -> Result<Reply, ProviderError> {
        assert!(request.tools.iter().any(|tool| tool.name == "webfetch"));
        if request.messages.len() == 1 {
            return Ok(Reply {
                content: json!([{"type":"tool_use","id":"fetch","name":"webfetch","input":{"url":self.url}}]),
                usage: json!({}),
                needs_tools: true,
            });
        }
        assert!(serde_json::to_string(&request.messages)
            .unwrap()
            .contains("network-ok"));
        Ok(Reply {
            content: json!([{"type":"text","text":"done"}]),
            usage: json!({}),
            needs_tools: false,
        })
    }
}

#[tokio::test]
async fn runtime_fetch_waits_for_bound_controller_approval_before_any_http_request() {
    let (address, mut seen, task) = server(vec![("/ok", page("text/plain", "network-ok"))]).await;
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("engine.db")).await.unwrap();
    let tools = Tools::new(dir.path()).await.unwrap();
    assert!(!tools
        .definitions()
        .iter()
        .any(|tool| tool.name == "webfetch"));
    let runtime = Runtime::with_policy(
        store.clone(),
        Arc::new(Fetcher {
            url: format!("{address}/ok"),
        }),
        tools,
        policy(vec![]),
    )
    .await
    .unwrap();
    runtime
        .admit(
            Input {
                session_id: "s".into(),
                input_id: "one".into(),
                prompt: "fetch it".into(),
                delivery: Delivery::Steer,
            },
            true,
        )
        .await
        .unwrap();
    let approval: Approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(event) = store
                .events("s", 0, 100)
                .await
                .unwrap()
                .into_iter()
                .find(|event| event.kind == "approval.requested")
            {
                break serde_json::from_value(event.data).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(seen.try_recv().is_err());
    let response = ApprovalResponse {
        request_id: approval.request_id,
        input_hash: approval.input_hash,
        policy_revision: approval.policy_revision,
        decision: Decision::Allow,
        matcher: None,
    };
    runtime
        .approve(&runtime.controller(), "s", response)
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
            .await
            .unwrap()
            .unwrap()["path"],
        "/ok"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if store
                .events("s", 0, 100)
                .await
                .unwrap()
                .iter()
                .any(|event| event.kind == "run.finished" && event.data["reason"] == "completed")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    runtime.shutdown().await;
    task.abort();
}
