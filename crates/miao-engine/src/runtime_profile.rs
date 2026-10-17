use crate::{permission::digest, provider::ProviderError, store::Store};
use serde_json::{json, Map, Value};

mod cache;

/// This evidence is supplied by the executing runtime, never inferred from a
/// provider packet or a product's model/agent catalog.
#[derive(Clone)]
pub(crate) struct Scope {
    pub store: Store,
    pub session: String,
    pub run: String,
    pub step: usize,
    pub context_epoch: u64,
    pub agent: Value,
    pub permissions: Value,
}

tokio::task_local! { static SCOPE: Scope; }
pub(crate) fn context_epoch() -> Option<u64> {
    SCOPE.try_with(|scope| scope.context_epoch).ok()
}

pub(crate) fn permission_hash() -> Option<String> {
    SCOPE
        .try_with(|scope| fingerprint(&scope.permissions).ok())
        .ok()
        .flatten()
}

pub(crate) async fn cache_prefix_completed(proof: Option<crate::cache_affinity::Proof>) {
    let (Ok(scope), Some(proof)) = (SCOPE.try_with(Clone::clone), proof) else {
        return;
    };
    // Missing persistence can lose an optimization, not fail a completed turn
    // and accidentally turn an already-billed answer into a retried request.
    let _ = scope
        .store
        .record(&scope.session, "cache.prefix.completed", json!(proof))
        .await;
}

pub(crate) async fn scoped<F: std::future::Future>(scope: Scope, future: F) -> F::Output {
    SCOPE.scope(scope, future).await
}

pub(crate) async fn record(
    protocol: &str,
    request: &reqwest::Request,
    attempt: usize,
) -> Result<Option<u64>, ProviderError> {
    let Ok(scope) = SCOPE.try_with(Clone::clone) else {
        return Ok(None);
    };
    let bytes = request
        .body()
        .and_then(reqwest::Body::as_bytes)
        .ok_or_else(|| {
            ProviderError::Stream("runtime profile requires a buffered provider request".into())
        })?;
    let body: Value = serde_json::from_slice(bytes).map_err(|_| {
        ProviderError::Stream("runtime profile requires a JSON provider request".into())
    })?;
    let profile = capture(
        protocol,
        &body,
        request.url().path(),
        &scope.agent,
        &scope.permissions,
    )?;
    let previous = scope
        .store
        .latest_event(&scope.session, "provider.request")
        .await
        .map_err(|_| {
            ProviderError::Stream("previous request observation could not be loaded".into())
        })?;
    let cache = cache::observe(
        protocol,
        request,
        &body,
        &profile,
        scope.context_epoch,
        previous.as_ref(),
    )?;
    // Recording is awaited before provider transport, so failed and retried attempts
    // remain observable even when no stream delta or successful reply exists.
    let event = scope.store.record(&scope.session, "provider.request", json!({
        "run_id": scope.run, "step": scope.step, "attempt": attempt,"phase":"prepared",
        "context_epoch":scope.context_epoch, "agent":scope.agent,"permissions":scope.permissions,
        "protocol": protocol, "request_body_sha256": digest(bytes), "profile": profile,
        "cache_diagnostics": cache,
    })).await.map_err(|_| ProviderError::Stream("runtime request profile could not be recorded".into()))?;
    Ok(Some(event.seq))
}

pub(crate) async fn result(
    request_seq: Option<u64>,
    status: Option<u16>,
    outcome: &str,
    detail: Option<&str>,
) -> Result<(), ProviderError> {
    let Some(request_seq) = request_seq else {
        return Ok(());
    };
    let scope = SCOPE
        .try_with(Clone::clone)
        .map_err(|_| ProviderError::Stream("runtime request scope was lost".into()))?;
    // A non-success status is opaque without the provider's error body; keep a
    // bounded copy on the durable result so a failure stays diagnosable.
    scope.store.record(&scope.session,"provider.request.result",json!({
        "run_id":scope.run,"step":scope.step,"request_seq":request_seq,"http_status":status,"outcome":outcome,
        "response_body":detail,
    })).await.map_err(|_| ProviderError::Stream("runtime request result could not be recorded".into()))?;
    Ok(())
}

fn capture(
    protocol: &str,
    body: &Value,
    path: &str,
    agent: &Value,
    permissions: &Value,
) -> Result<Value, ProviderError> {
    let request = body
        .as_object()
        .ok_or_else(|| ProviderError::Stream("provider request must be an object".into()))?;
    let model = if protocol == "gemini" {
        path.split("/models/")
            .nth(1)
            .and_then(|model| model.strip_suffix(":streamGenerateContent"))
    } else {
        body["model"].as_str()
    }
    .filter(|model| !model.is_empty())
    .map(|model| -> Result<String, ProviderError> {
        if protocol == "gemini" {
            return percent_encoding::percent_decode_str(model)
                .decode_utf8()
                .map(|model| model.into_owned())
                .map_err(|_| ProviderError::Stream("invalid encoded wire model".into()));
        }
        Ok(model.to_owned())
    })
    .transpose()?;
    // A custom endpoint can select its model outside the observable packet.
    // Keep that wire identity unknown; profile observation must not prevent a
    // valid request or substitute the runtime's configured model as evidence.
    let instructions: Map<String, Value> = request
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "system" | "instructions" | "systemInstruction"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let roles: Vec<Value> = body
        .get("messages")
        .or_else(|| body.get("input"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|message| matches!(message["role"].as_str(), Some("system" | "developer")))
        .cloned()
        .collect();
    let parameters: Map<String, Value> = request
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "model"
                    | "messages"
                    | "input"
                    | "contents"
                    | "system"
                    | "instructions"
                    | "systemInstruction"
                    | "tools"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Ok(json!({
        "coverage": if model.is_some() { "runtime-and-wire" } else { "runtime-and-request" }, "model": model,
        "modelParametersHash": fingerprint(&json!({"protocol":protocol,"parameters":parameters}))?,
        "agentManifestHash": fingerprint(&json!({"agent":agent,"instructions":instructions,"roles":roles}))?,
        "permissionHash": fingerprint(permissions)?,
        "toolSurfaceHash": fingerprint(&json!({"protocol":protocol,"present":request.contains_key("tools"),"tools":body.get("tools").unwrap_or(&Value::Null)}))?,
    }))
}

fn fingerprint(value: &Value) -> Result<String, ProviderError> {
    // RFC 8785 uses ECMAScript number/string serialization and UTF-16 key
    // ordering, matching EngineWireProfile even for 1.0 and Unicode keys.
    serde_jcs::to_vec(value)
        .map(|bytes| digest(&bytes))
        .map_err(|_| ProviderError::Stream("runtime profile could not be fingerprinted".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::{Access, Config, Decision, Mode, Policy};

    #[test]
    fn actual_parameters_ordered_tools_and_effective_policy_change_the_bound_profile() {
        let agent = json!({"name":"native-runtime","collaborationMode":"build"});
        let readonly = Policy::new(Config::default()).unwrap();
        let writable = Policy::new(Config {
            mode: Mode::Workspace,
            ..Config::default()
        })
        .unwrap();
        assert_eq!(
            readonly.evaluate("write_file", "file", Access::Write),
            Decision::Deny
        );
        assert_eq!(
            writable.evaluate("write_file", "file", Access::Write),
            Decision::Ask
        );
        let body = json!({"model":"wire-model","temperature":1,"messages":[{"role":"system","content":"instruction"}],"tools":[{"name":"a"},{"name":"b"}]});
        let original = capture("openai-chat", &body, "", &agent, &readonly.descriptor()).unwrap();
        let changed = capture("openai-chat", &body, "", &agent, &writable.descriptor()).unwrap();
        assert_ne!(original["permissionHash"], changed["permissionHash"]);
        assert_eq!(original["agentManifestHash"], changed["agentManifestHash"]);
        let mut reordered = body.clone();
        reordered["tools"].as_array_mut().unwrap().reverse();
        assert_ne!(
            original["toolSurfaceHash"],
            capture(
                "openai-chat",
                &reordered,
                "",
                &agent,
                &readonly.descriptor()
            )
            .unwrap()["toolSurfaceHash"]
        );
        assert_eq!(
            fingerprint(&json!({"value":1})).unwrap(),
            fingerprint(&json!({"value":1.0})).unwrap()
        );
        assert_eq!(
            capture(
                "gemini",
                &json!({}),
                "/v1/models/a%2Bb:streamGenerateContent",
                &agent,
                &json!({})
            )
            .unwrap()["model"],
            "a+b"
        );
    }

    #[test]
    fn opaque_endpoint_keeps_wire_model_unknown_without_guessing_configuration() {
        let profile = capture(
            "gemini",
            &json!({"contents":[]}),
            "/custom",
            &json!({"name":"native-runtime"}),
            &json!({"policy":"fixture"}),
        )
        .unwrap();
        assert_eq!(profile["model"], Value::Null);
        assert_eq!(profile["coverage"], "runtime-and-request");
        assert!(profile["permissionHash"].as_str().is_some());
    }

    #[tokio::test]
    async fn only_explicit_native_storage_identities_can_be_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let recorded = root.join("record.db");
        let replayed = root.join("replay.db");
        std::fs::write(&recorded, "private").unwrap();
        std::fs::write(&replayed, "private").unwrap();
        let tools = crate::tools::Tools::new(&root).await.unwrap();
        let first = tools.clone().protect_store(&recorded);
        let second = tools.clone().protect_store(&replayed);
        assert_eq!(first.authority_descriptor(), second.authority_descriptor());
        assert!(first
            .prepare("read_file", json!({"path":"record.db"}))
            .await
            .is_err());
        assert!(second
            .prepare("read_file", json!({"path":"replay.db"}))
            .await
            .is_err());
        assert_ne!(
            tools
                .clone()
                .with_protected_resource(&recorded)
                .authority_descriptor(),
            tools
                .with_protected_resource(&replayed)
                .authority_descriptor(),
        );
    }

    #[tokio::test]
    async fn actual_request_receipts_are_durable_and_do_not_capture_headers_or_query_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("native.db")).await.unwrap();
        store.ensure("session").await.unwrap();
        let request = reqwest::Client::new()
            .post("https://example.invalid/chat?key=private-query")
            .header("authorization", "private-header")
            .json(&json!({"model":"wire-model","messages":[]}))
            .build()
            .unwrap();
        let scope = Scope {
            store: store.clone(),
            session: "session".into(),
            run: "run".into(),
            step: 2,
            context_epoch: 3,
            agent: json!({"name":"native-runtime"}),
            permissions: json!({"config":{}}),
        };
        scoped(scope, async {
            record("openai-chat", &request, 1).await.unwrap();
            record("openai-chat", &request, 2).await.unwrap();
        })
        .await;
        let events = store.events("session", 0, 100).await.unwrap();
        let receipts: Vec<_> = events
            .iter()
            .filter(|event| event.kind == "provider.request")
            .collect();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0].data["attempt"], 1);
        assert_eq!(receipts[1].data["attempt"], 2);
        assert_eq!(receipts[0].data["step"], 2);
        assert_eq!(receipts[0].data["profile"]["coverage"], "runtime-and-wire");
        assert_eq!(
            receipts[0].data["cache_diagnostics"]["historyState"],
            "initial"
        );
        assert_eq!(
            receipts[1].data["cache_diagnostics"]["historyState"],
            "unchanged"
        );
        assert_eq!(
            receipts[1].data["cache_diagnostics"]["previousRequestSeq"],
            receipts[0].seq
        );
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("private-query"));
        assert!(!serialized.contains("private-header"));
    }

    #[tokio::test]
    async fn cache_report_distinguishes_missing_usage_from_zero_and_preserves_scope_lineage() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("native.db")).await.unwrap();
        store.ensure("session").await.unwrap();
        let request = reqwest::Client::new()
            .post("https://example.invalid/responses")
            .json(&json!({"model":"m","input":[]}))
            .build()
            .unwrap();
        for step in 1..=2 {
            let scope = Scope {
                store: store.clone(),
                session: "session".into(),
                run: format!("run-{step}"),
                step,
                context_epoch: 1,
                agent: json!({}),
                permissions: json!({}),
            };
            scoped(scope, record("openai-responses", &request, 1))
                .await
                .unwrap();
        }
        let report = store.usage_report("session").await.unwrap();
        assert_eq!(report["turns"], 0);
        assert_eq!(report["cacheDiagnostics"]["observedRequests"], 2);
        assert_eq!(report["cacheDiagnostics"]["historyStates"]["unchanged"], 1);
        assert_eq!(report["cacheDiagnostics"]["coverage"]["cacheRead"], 0);
        assert!(report["cacheDiagnostics"]["hitRatio"].is_null());
        store.record("session","usage",json!({"run_id":"run-2","step":2,"usage":{"inputTokens":100,"outputTokens":1,"cacheReadInputTokens":75}})).await.unwrap();
        let report = store.usage_report("session").await.unwrap();
        assert_eq!(report["turns"], 1);
        assert_eq!(report["cacheDiagnostics"]["hitRatio"], 0.75);
        store
            .record(
                "session",
                "usage",
                json!({"run_id":"run-3","step":3,"usage":{"inputTokens":100,"outputTokens":1}}),
            )
            .await
            .unwrap();
        let report = store.usage_report("session").await.unwrap();
        assert_eq!(report["cacheDiagnostics"]["usageObservations"], 2);
        assert_eq!(report["cacheDiagnostics"]["coverage"]["cacheRead"], 1);
        assert_eq!(report["cacheDiagnostics"]["coverage"]["cacheWrite"], 0);
        assert!(report["cacheDiagnostics"]["hitRatio"].is_null());
        store.ensure("invalid").await.unwrap();
        store
            .record(
                "invalid",
                "usage",
                json!({"run_id":"r","step":1,"usage":{"inputTokens":10,"cacheReadInputTokens":20}}),
            )
            .await
            .unwrap();
        let invalid = store.usage_report("invalid").await.unwrap();
        assert_eq!(invalid["cacheDiagnostics"]["invalidBreakdowns"], 1);
        assert!(invalid["cacheDiagnostics"]["hitRatio"].is_null());
    }
}
