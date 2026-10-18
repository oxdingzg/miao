//! Purpose-role model bindings (ADR-14). Three named roles — `summarize`,
//! `retrieve`, `verify` — may each bind a model id on the Session's own
//! provider; credentials and placement stay with the Session. An unbound
//! role, or a binding the provider rejects, runs on the primary model, and
//! every substitution is recorded rather than silent.

use crate::provider::Provider;
use serde_json::json;
use std::sync::Arc;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bindings {
    pub summarize: Option<String>,
    pub retrieve: Option<String>,
    pub verify: Option<String>,
}

impl Bindings {
    pub fn binding(&self, role: &str) -> Option<&str> {
        match role {
            "summarize" => self.summarize.as_deref(),
            "retrieve" => self.retrieve.as_deref(),
            "verify" => self.verify.as_deref(),
            _ => None,
        }
    }
}

/// What the engine actually does with a role binding.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    /// No binding: the role runs on the primary model.
    Primary,
    /// The provider accepted the binding.
    Bound { model: String },
    /// The provider rejected the binding; the primary runs instead and the
    /// substitution is part of the evidence.
    Substituted { requested: String },
}

impl Resolution {
    pub fn to_evidence(&self) -> serde_json::Value {
        match self {
            Resolution::Primary => json!({"binding": null, "using": "primary"}),
            Resolution::Bound { model } => json!({"binding": model, "using": "bound"}),
            Resolution::Substituted { requested } => {
                json!({"binding": requested, "using": "primary", "substituted": true})
            }
        }
    }
}

/// Bind `role` to a provider instance. `for_model` keeps credentials,
/// endpoint, and placement on the Session's own route, so a rejected model id
/// is the only way a binding fails, and it fails into a recorded substitution.
pub fn resolve(
    primary: &Arc<dyn Provider>,
    binding: Option<&str>,
) -> (Arc<dyn Provider>, Resolution) {
    match binding {
        None => (Arc::clone(primary), Resolution::Primary),
        Some(model) => match primary.for_model(model) {
            Some(provider) => (
                provider,
                Resolution::Bound {
                    model: model.to_owned(),
                },
            ),
            None => (
                Arc::clone(primary),
                Resolution::Substituted {
                    requested: model.to_owned(),
                },
            ),
        },
    }
}

/// One summarizer attempt against one provider: send the retention-directed
/// summarization request and collect the reply text.
async fn summarize_with(
    provider: &Arc<dyn Provider>,
    stop: &tokio_util::sync::CancellationToken,
    body: &str,
    settlement: Option<&Settlement<'_>>,
) -> Result<String, String> {
    use crate::protocol::{Message, ModelRequest};
    let request = ModelRequest {
        system: "Summarize the conversation portion you are given. Preserve verbatim: the active objective, open tasks, verification commands and their results, file paths, identifiers, and decisions. Reply with only the summary text.".into(),
        messages: vec![Message {
            role: "user".into(),
            content: json!([{"type": "text", "text": body}]),
            checkpoint: None,
            recorded_at_ms: None,
        }],
        tools: vec![],
    };
    request_summary(provider, stop, request, false, settlement).await
}

async fn request_summary(
    provider: &Arc<dyn Provider>,
    stop: &tokio_util::sync::CancellationToken,
    request: crate::protocol::ModelRequest,
    without_tools: bool,
    settlement: Option<&Settlement<'_>>,
) -> Result<String, String> {
    // Progress must be drained even though only the final text is consumed.
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let path = if without_tools { "prefix" } else { "cold" };
    let started_seq = if let Some(owner) = settlement {
        Some(owner.store.record(owner.session,"role.provider.started",json!({"run_id":owner.run,"role":"summarize","path":path,"identity":provider.identity()})).await.map_err(|error|error.to_string())?.seq)
    } else {
        None
    };
    let result = if without_tools {
        provider
            .stream_without_tools(request, tx, stop.child_token())
            .await
    } else {
        provider.stream(request, tx, stop.child_token()).await
    };
    let summary = result
        .as_ref()
        .map_err(|error| error.to_string())
        .and_then(summary_text);
    if let Some(owner) = settlement {
        let observed = result.as_ref().ok().or_else(|| {
            result
                .as_ref()
                .err()
                .and_then(|error| error.continuation().map(|(reply, _)| reply))
        });
        let reply_identity = observed.and_then(|reply| provider.reply_identity(reply));
        let identity_source = if reply_identity.is_some() {
            "reply"
        } else if provider.identity().is_some() {
            "request"
        } else {
            "unknown"
        };
        owner.store.record(owner.session,"role.provider.completed",json!({"run_id":owner.run,"startedSeq":started_seq,"role":"summarize","path":path,"providerSuccess":result.is_ok(),"accepted":summary.is_ok(),"reason":summary.as_ref().err(),"identity":reply_identity.or_else(||provider.identity()),"identitySource":identity_source,"usage":observed.map(|reply|&reply.usage)})).await.map_err(|error|error.to_string())?;
    }
    summary
}

fn summary_text(reply: &crate::provider::Reply) -> Result<String, String> {
    if reply.needs_tools
        || reply
            .content
            .as_array()
            .into_iter()
            .flatten()
            .any(|block| block["type"] == "tool_use")
    {
        return Err("summarizer returned a tool call; no calls were dispatched".into());
    }
    let text = reply
        .content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    if text.trim().is_empty() {
        Err("summarizer returned no text".into())
    } else {
        Ok(text)
    }
}

pub(crate) async fn summarize_prefix(
    provider: &Arc<dyn Provider>,
    settlement: &Settlement<'_>,
    stop: &tokio_util::sync::CancellationToken,
    mut request: crate::protocol::ModelRequest,
) -> Result<String, String> {
    request.messages.push(crate::protocol::Message {
        role:"user".into(),
        content:json!([{"type":"text","text":"Summarize the conversation above for continuation. Preserve the active objective, constraints, open tasks, verification commands and results, exact file paths and identifiers, decisions, and recall handles for omitted tool output. Do not perform any tools or new work. Reply with only the summary text."}]),
        checkpoint:None,recorded_at_ms:None,
    });
    request_summary(provider, stop, request, true, Some(settlement)).await
}

/// The `summarize` role's attempt with ADR-14's single escalation: the bound
/// provider goes first; when it fails — provider error or unusable output —
/// the primary retries once and the escalation lands in the evidence instead
/// of failing the turn. `escalate` is false when the attempt already ran on
/// the primary model (no binding, or a substituted one): that attempt does not
/// retry itself.
/// Where an auxiliary attempt records its evidence: the delegating Session's
/// store, the Session itself, and the run that asked for the role.
pub struct Settlement<'a> {
    pub store: &'a crate::store::Store,
    pub session: &'a str,
    pub run: &'a str,
}

pub async fn summarize_with_escalation(
    role_provider: &Arc<dyn Provider>,
    primary: &Arc<dyn Provider>,
    settlement: &Settlement<'_>,
    stop: &tokio_util::sync::CancellationToken,
    body: &str,
    escalate: bool,
) -> Result<String, String> {
    match summarize_with(role_provider, stop, body, Some(settlement)).await {
        Ok(text) => Ok(text),
        Err(first) if escalate => {
            let _ = settlement
                .store
                .record(
                    settlement.session,
                    "role.escalated",
                    json!({"run_id":settlement.run,"role":"summarize","reason":first}),
                )
                .await;
            summarize_with(primary, stop, body, Some(settlement)).await
        }
        Err(first) => Err(first),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ModelRequest;
    use crate::provider::{CountTokens, ProviderError, Reply};
    use serde_json::Value;
    use tokio_util::sync::CancellationToken;

    struct Fixed {
        accepts: Vec<String>,
        model: String,
        fail_stream: bool,
    }

    impl Fixed {
        fn primary(accepts: Vec<String>) -> Arc<dyn Provider> {
            Arc::new(Fixed {
                accepts,
                model: "primary".into(),
                fail_stream: false,
            })
        }
    }

    #[async_trait::async_trait]
    impl Provider for Fixed {
        fn identity(&self) -> Option<crate::provider::Identity> {
            Some(crate::provider::Identity {
                protocol: "test".into(),
                model: self.model.clone(),
            })
        }
        fn for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
            self.accepts
                .iter()
                .any(|accepted| accepted == model)
                .then(|| {
                    Arc::new(Fixed {
                        accepts: self.accepts.clone(),
                        model: model.to_owned(),
                        fail_stream: self.fail_stream,
                    }) as Arc<dyn Provider>
                })
        }
        async fn stream(
            &self,
            _: ModelRequest,
            _: tokio::sync::mpsc::Sender<Value>,
            _: CancellationToken,
        ) -> Result<Reply, ProviderError> {
            if self.fail_stream {
                return Err(ProviderError::Transport);
            }
            Ok(Reply {
                content: json!([{"type": "text", "text": "ok summary"}]),
                usage: json!({}),
                needs_tools: false,
            })
        }
        async fn count_tokens(&self, _: &ModelRequest) -> CountTokens {
            unreachable!("resolve never counts")
        }
    }

    #[test]
    fn unbound_roles_resolve_to_primary_without_evidence_noise() {
        let primary = Fixed::primary(vec![]);
        let (provider, resolution) = resolve(&primary, None);
        assert!(Arc::ptr_eq(&provider, &primary));
        assert_eq!(resolution, Resolution::Primary);
        assert_eq!(resolution.to_evidence()["using"], "primary");
    }

    #[test]
    fn an_accepted_binding_selects_that_model_on_the_same_route() {
        let primary = Fixed::primary(vec!["glm-5.3-flash".into()]);
        let (provider, resolution) = resolve(&primary, Some("glm-5.3-flash"));
        assert_eq!(
            provider.identity().unwrap().model,
            "glm-5.3-flash",
            "the bound model serves the role"
        );
        assert_eq!(
            resolution,
            Resolution::Bound {
                model: "glm-5.3-flash".into()
            }
        );
    }

    #[test]
    fn a_rejected_binding_substitutes_the_primary_and_records_it() {
        let primary = Fixed::primary(vec![]);
        let (provider, resolution) = resolve(&primary, Some("nope"));
        assert!(Arc::ptr_eq(&provider, &primary));
        assert_eq!(
            resolution,
            Resolution::Substituted {
                requested: "nope".into()
            }
        );
        let evidence = resolution.to_evidence();
        assert_eq!(evidence["using"], "primary");
        assert_eq!(evidence["substituted"], true);
    }

    #[tokio::test]
    async fn a_failed_role_attempt_escalates_once_to_the_primary() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path().join("engine.db"))
            .await
            .unwrap();
        store
            .admit(crate::protocol::Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "seed".into(),
                prompt: "task".into(),
                delivery: crate::protocol::Delivery::Steer,
            })
            .await
            .unwrap();
        let role: Arc<dyn Provider> = Arc::new(Fixed {
            accepts: vec![],
            model: "mini".into(),
            fail_stream: true,
        });
        let primary = Fixed::primary(vec![]);
        let stop = CancellationToken::new();
        let text = summarize_with_escalation(
            &role,
            &primary,
            &Settlement {
                store: &store,
                session: "s",
                run: "r1",
            },
            &stop,
            "condense this",
            true,
        )
        .await
        .unwrap();
        assert_eq!(text, "ok summary");
        let events = store.events("s", 0, 100).await.unwrap();
        let escalated = events
            .iter()
            .find(|event| event.kind == "role.escalated")
            .unwrap();
        assert_eq!(escalated.data["role"], "summarize");
        assert_eq!(escalated.data["run_id"], "r1");
    }

    #[tokio::test]
    async fn an_attempt_already_on_the_primary_does_not_retry_itself() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path().join("engine.db"))
            .await
            .unwrap();
        store
            .admit(crate::protocol::Input {
                agent_references: Default::default(),
                command: None,
                session_id: "s".into(),
                input_id: "seed".into(),
                prompt: "task".into(),
                delivery: crate::protocol::Delivery::Steer,
            })
            .await
            .unwrap();
        let failing: Arc<dyn Provider> = Arc::new(Fixed {
            accepts: vec![],
            model: "primary".into(),
            fail_stream: true,
        });
        let stop = CancellationToken::new();
        let error = summarize_with_escalation(
            &failing,
            &failing,
            &Settlement {
                store: &store,
                session: "s",
                run: "r1",
            },
            &stop,
            "condense this",
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "provider transport failed");
        let events = store.events("s", 0, 100).await.unwrap();
        assert!(!events.iter().any(|event| event.kind == "role.escalated"));
    }

    struct Chatty {
        frames: usize,
    }

    #[async_trait::async_trait]
    impl Provider for Chatty {
        fn identity(&self) -> Option<crate::provider::Identity> {
            Some(crate::provider::Identity {
                protocol: "test".into(),
                model: "chatty".into(),
            })
        }
        fn for_model(&self, _: &str) -> Option<Arc<dyn Provider>> {
            None
        }
        async fn stream(
            &self,
            _: ModelRequest,
            progress: tokio::sync::mpsc::Sender<Value>,
            _: CancellationToken,
        ) -> Result<Reply, ProviderError> {
            for nth in 0..self.frames {
                if progress
                    .send(json!({"kind":"delta","delta":{"type":"text","text":"x"},"nth":nth}))
                    .await
                    .is_err()
                {
                    return Err(ProviderError::Interrupted);
                }
            }
            Ok(Reply {
                content: json!([{"type": "text", "text": "ok summary"}]),
                usage: json!({}),
                needs_tools: false,
            })
        }
        async fn count_tokens(&self, _: &ModelRequest) -> CountTokens {
            unreachable!("the summarizer never counts")
        }
    }

    #[tokio::test]
    async fn a_summary_reply_beyond_the_progress_capacity_cannot_stall_the_call() {
        let provider: Arc<dyn Provider> = Arc::new(Chatty { frames: 32 });
        let stop = CancellationToken::new();
        let text = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            summarize_with(&provider, &stop, "condense this", None),
        )
        .await
        .expect("the summarizer must not stall on its own undrained progress feed")
        .unwrap();
        assert_eq!(text, "ok summary");
    }

    #[test]
    fn bindings_are_looked_up_by_role_name() {
        let bindings = Bindings {
            summarize: Some("a".into()),
            verify: Some("c".into()),
            ..Bindings::default()
        };
        assert_eq!(bindings.binding("summarize"), Some("a"));
        assert_eq!(bindings.binding("retrieve"), None);
        assert_eq!(bindings.binding("verify"), Some("c"));
        assert_eq!(bindings.binding("primary"), None);
    }
}
