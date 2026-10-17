//! Client-observable cache lineage, not an assertion about server KV state.
//! Keep content and credentials out of the journal: store bounded fingerprints.
use super::fingerprint;
use crate::{protocol::Event, provider::ProviderError};
use serde_json::{json, Value};

const PREFIX_SAMPLES: usize = 128;

pub(super) fn observe(
    protocol: &str,
    request: &reqwest::Request,
    body: &Value,
    profile: &Value,
    context_epoch: u64,
    previous: Option<&Event>,
) -> Result<Value, ProviderError> {
    let previous = previous.filter(|event| event.data["cache_diagnostics"]["version"] == 1);
    let before = previous.map(|event| &event.data["cache_diagnostics"]["snapshot"]);
    let messages = body
        .get("messages")
        .or_else(|| body.get("input"))
        .or_else(|| body.get("contents"))
        .and_then(Value::as_array);
    let system = json!({
        "system":body.get("system"), "instructions":body.get("instructions"),
        "systemInstruction":body.get("systemInstruction"),
        "roles":messages.into_iter().flatten().take_while(|item| matches!(item["role"].as_str(), Some("system"|"developer"))).collect::<Vec<_>>(),
    });
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let account = header("chatgpt-account-id");
    let url = request.url();
    let route = json!({"scheme":url.scheme(),"host":url.host_str(),"port":url.port_or_known_default(),"path":url.path()});
    let keys = json!({"body":body.get("prompt_cache_key"),"sessionHeader":header("session-id"),"sessionHeaderLegacy":header("session_id")});
    let history_hash = messages
        .map(|items| fingerprint(&json!(items)))
        .transpose()?;
    let history_prefix = messages
        .map(|items| {
            items
                .iter()
                .take(PREFIX_SAMPLES)
                .map(fingerprint)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let preceding_count = before
        .and_then(|item| item["historyCount"].as_u64())
        .and_then(|count| usize::try_from(count).ok());
    // One whole-prefix digest proves append-only growth without persisting
    // an unbounded array of hashes for every item in a long conversation.
    let preceding_prefix = messages
        .zip(preceding_count)
        .filter(|(items, count)| *count <= items.len())
        .map(|(items, count)| fingerprint(&json!(&items[..count])))
        .transpose()?;
    let snapshot = json!({
        "protocol":protocol, "transport":"http", "routeHash":fingerprint(&route)?,
        "model":profile["model"], "parametersHash":profile["modelParametersHash"],
        "systemHash":fingerprint(&system)?, "toolsHash":profile["toolSurfaceHash"],
        "permissionsHash":profile["permissionHash"], "contextEpoch":context_epoch,
        "cacheKeyHash":fingerprint(&keys)?,
        "accountHash":account.map(|account| fingerprint(&json!(account))).transpose()?,
        "historyHash":history_hash, "historyCount":messages.map(Vec::len),
        "historyPrefixHashes":history_prefix, "precedingPrefixHash":preceding_prefix,
    });
    let Some(before) = before else {
        return Ok(
            json!({"version":1,"snapshot":snapshot,"historyState":"initial","changes":["initial-observation"],"serverCacheState":"unknown"}),
        );
    };
    let history_state = match (
        before["historyCount"].as_u64(),
        snapshot["historyCount"].as_u64(),
    ) {
        (Some(old), Some(new))
            if old == new && before["historyHash"] == snapshot["historyHash"] =>
        {
            "unchanged"
        }
        (Some(old), Some(new))
            if new > old && before["historyHash"] == snapshot["precedingPrefixHash"] =>
        {
            "extended"
        }
        (Some(old), Some(new)) if new < old => "shortened",
        (Some(_), Some(_)) => "rewritten",
        _ => "unknown",
    };
    let fields = [
        ("protocol", "protocol-changed"),
        ("transport", "transport-changed"),
        ("routeHash", "route-changed"),
        ("model", "model-changed"),
        ("parametersHash", "parameters-changed"),
        ("systemHash", "system-changed"),
        ("toolsHash", "tools-changed"),
        ("permissionsHash", "permissions-changed"),
        ("contextEpoch", "context-epoch-changed"),
        ("cacheKeyHash", "cache-key-changed"),
        ("accountHash", "account-changed"),
    ];
    let mut changes = fields
        .into_iter()
        .filter(|(field, _)| before[*field] != snapshot[*field])
        .map(|(_, change)| change)
        .collect::<Vec<_>>();
    if matches!(history_state, "rewritten" | "shortened") {
        changes.push(if history_state == "rewritten" {
            "history-rewritten"
        } else {
            "history-shortened"
        });
    }
    let shared = before["historyPrefixHashes"]
        .as_array()
        .zip(snapshot["historyPrefixHashes"].as_array())
        .map(|(old, new)| {
            old.iter()
                .zip(new)
                .take_while(|(old, new)| old == new)
                .count()
        });
    Ok(json!({
        "version":1,"snapshot":snapshot,"previousRequestSeq":previous.map(|event|event.seq),
        "historyState":history_state,"changes":changes,"sharedPrefixMessages":shared,
        "prefixSampleLimit":PREFIX_SAMPLES,"serverCacheState":"unknown",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_profile::capture;

    fn observation(body: Value, previous: Option<&Event>, epoch: u64, url: &str) -> Value {
        let request = reqwest::Client::new()
            .post(url)
            .header("authorization", "never-record-this")
            .header("session-id", "stable-session")
            .json(&body)
            .build()
            .unwrap();
        let profile = capture(
            "openai-responses",
            &body,
            "/responses",
            &json!({}),
            &json!({}),
        )
        .unwrap();
        observe(
            "openai-responses",
            &request,
            &body,
            &profile,
            epoch,
            previous,
        )
        .unwrap()
    }

    fn event(cache: Value) -> Event {
        Event {
            session_id: "s".into(),
            seq: 12,
            kind: "provider.request".into(),
            data: json!({"cache_diagnostics":cache}),
            recorded_at_ms: Some(1),
        }
    }

    #[test]
    fn append_only_history_is_distinct_from_rewrites_and_context_selection_changes() {
        let body = json!({"model":"m","instructions":"private-system","tools":[],"input":[{"role":"user","content":"one"}]});
        let first = event(observation(
            body.clone(),
            None,
            1,
            "https://example.invalid/responses?key=private-query",
        ));
        let same = observation(
            body.clone(),
            Some(&first),
            1,
            "https://example.invalid/responses?key=other-private-query",
        );
        assert_eq!(same["historyState"], "unchanged");
        assert_eq!(same["changes"], json!([]));
        let mut extended = body.clone();
        extended["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"assistant","content":"two"}));
        let after = observation(
            extended.clone(),
            Some(&first),
            2,
            "https://example.invalid/responses",
        );
        assert_eq!(after["historyState"], "extended");
        assert_eq!(after["changes"], json!(["context-epoch-changed"]));
        assert_eq!(after["serverCacheState"], "unknown");
        let mut update = extended.clone();
        update["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"system","content":"chronological update"}));
        let update = observation(update, Some(&first), 1, "https://example.invalid/responses");
        assert_eq!(update["historyState"], "extended");
        assert_eq!(update["changes"], json!([]));
        let rewritten = observation(
            json!({"model":"m","instructions":"changed","tools":[{"name":"new"}],"input":[{"role":"user","content":"other"}]}),
            Some(&first),
            1,
            "https://other.invalid/responses",
        );
        for reason in [
            "route-changed",
            "system-changed",
            "tools-changed",
            "history-rewritten",
        ] {
            assert!(rewritten["changes"]
                .as_array()
                .unwrap()
                .contains(&json!(reason)));
        }
        let shortened = observation(
            body,
            Some(&event(after)),
            2,
            "https://example.invalid/responses",
        );
        assert_eq!(shortened["historyState"], "shortened");
        let serialized = first.data.to_string();
        for private in [
            "private-system",
            "private-query",
            "never-record-this",
            "stable-session",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn long_history_append_proof_is_exact_but_prefix_diagnostics_are_bounded() {
        let body = json!({"model":"m","input":(0..300).map(|n|json!({"role":"user","content":n})).collect::<Vec<_>>()});
        let first = event(observation(
            body.clone(),
            None,
            1,
            "https://example.invalid/responses",
        ));
        assert_eq!(
            first.data["cache_diagnostics"]["snapshot"]["historyPrefixHashes"]
                .as_array()
                .unwrap()
                .len(),
            PREFIX_SAMPLES
        );
        let mut next = body.clone();
        next["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user","content":"new"}));
        assert_eq!(
            observation(
                next.clone(),
                Some(&first),
                1,
                "https://example.invalid/responses"
            )["historyState"],
            "extended"
        );
        next["input"][250]["content"] = json!("changed beyond sample");
        assert_eq!(
            observation(next, Some(&first), 1, "https://example.invalid/responses")["historyState"],
            "rewritten"
        );
    }
}
