//! Commands are prepared by the serialized Session drain after promotion.
//! Host resolution captures data; all external effects remain engine-owned.
use super::{authorize, delegate, validate_agent, Delegation, Inner, TurnAuthority};
use crate::{
    protocol::{Attachment, CollaborationMode, Error},
    session_agent::AgentManifest,
    session_command::{Completion, Pending},
    store::SessionLease,
};
use serde_json::json;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

pub(super) async fn prepare_pending(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    lease: &SessionLease,
    cancel: CancellationToken,
) -> Result<(), Error> {
    let context = Context {
        inner,
        session,
        run,
        lease,
        cancel,
    };
    for input in inner.store.pending_commands(session).await? {
        if context.cancel.is_cancelled() {
            return Ok(());
        }
        if input.started {
            let message="Command preparation was interrupted or its outcome is unknown. It was not replayed.";
            inner.store.finish_command(session,&input,Completion {text:format!("Slash command failed: {message}\nDo not retry its side effects automatically; reconcile with the user before retrying."),attachments:Vec::new(),agents:Vec::new(),error:Some(message.into())},lease).await?;
            continue;
        }
        inner
            .store
            .start_command(session, &input, run, lease)
            .await?;
        match context.prepare(&input).await {
            Ok(prepared) => {
                inner
                    .store
                    .finish_command(
                        session,
                        &input,
                        Completion {
                            text: prepared.text,
                            attachments: prepared.attachments,
                            agents: prepared.agents,
                            error: None,
                        },
                        lease,
                    )
                    .await?
            }
            Err(error) => {
                let message = error.to_string();
                inner.store.finish_command(session,&input,Completion {text:format!("Slash command failed: {message}\nDo not retry its side effects automatically; reconcile with the user before retrying."),attachments:Vec::new(),agents:Vec::new(),error:Some(message)},lease).await?;
            }
        }
    }
    Ok(())
}

struct Context<'a> {
    inner: &'a Arc<Inner>,
    session: &'a str,
    run: &'a str,
    lease: &'a SessionLease,
    cancel: CancellationToken,
}
struct PreparedCommand {
    text: String,
    attachments: Vec<Attachment>,
    agents: Vec<crate::session_agent::AgentMention>,
}

impl Context<'_> {
    async fn prepare(&self, input: &Pending) -> Result<PreparedCommand, Error> {
        let parent = self
            .inner
            .store
            .agent(self.session)
            .await?
            .map(|(agent, _)| agent);
        let target = input
            .command
            .authority
            .as_ref()
            .and_then(|authority| authority.agent.clone())
            .or_else(|| parent.clone())
            .or_else(|| {
                input
                    .command
                    .authority
                    .as_ref()
                    .and_then(|authority| authority.default_agent.as_ref())
                    .and_then(|name| {
                        input
                            .agent_references
                            .catalog
                            .iter()
                            .find(|agent| agent.name.as_str() == name.as_str())
                    })
                    .cloned()
            });
        if let Some(agent) = &target {
            validate_agent(self.inner, agent)?;
        }
        let text = self.shells(input, target.as_ref()).await?;
        let mut attachments = input.attachments.clone();
        let mut agents = Vec::new();
        for (index, mention) in mentions(&text)?.into_iter().enumerate() {
            let name = &mention.name;
            let prepared = match self.inner.tools.prepare_command_reference(name).await {
                Ok(prepared) => prepared,
                Err(crate::tools::ToolError::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound =>
                {
                    if input
                        .agent_references
                        .catalog
                        .iter()
                        .any(|agent| agent.name.as_str() == name.as_str())
                    {
                        agents.push(mention);
                        continue;
                    }
                    return Err(Error::Invalid(format!(
                        "Command reference not found: {name}"
                    )));
                }
                Err(error) => return Err(Error::Invalid(error.to_string())),
            };
            let call = call_id(&input.input_id, "reference", index);
            let policy = self.inner.policy.for_agent(target.as_ref())?;
            self.inner.store.plan_command_call(self.session,self.run,&call,json!({"name":prepared.name(),"input":prepared.input(),"input_id":input.input_id,"resource":prepared.resource()}),self.lease).await?;
            let allowed = authorize(
                self.inner,
                self.session,
                self.run,
                &call,
                &prepared,
                self.cancel.child_token(),
                TurnAuthority {
                    plan: self.plan(target.as_ref()).await?,
                    policy: &policy,
                    agent: target.as_ref(),
                },
            )
            .await?;
            if !allowed {
                self.inner
                    .store
                    .finish_command_call(
                        self.session,
                        self.run,
                        &call,
                        Some("command reference refused".into()),
                        self.lease,
                    )
                    .await?;
                return Err(Error::Invalid(format!("Command reference refused: {name}")));
            }
            self.inner
                .store
                .dispatch_command_call(self.session, self.run, &call, self.lease)
                .await?;
            let attachment = self
                .inner
                .tools
                .read_command_reference(prepared, &policy, self.cancel.child_token())
                .await;
            self.inner
                .store
                .finish_command_call(
                    self.session,
                    self.run,
                    &call,
                    attachment.as_ref().err().map(ToString::to_string),
                    self.lease,
                )
                .await?;
            let mut attachment = attachment.map_err(|error| Error::Invalid(error.to_string()))?;
            let mut source = mention.source.clone().unwrap_or(serde_json::Value::Null);
            source["type"] = json!("file");
            source["path"] = json!(name);
            if let Some(source) = source.as_object_mut() {
                source.remove("name");
            }
            let metadata = attachment.metadata.get_or_insert_with(Default::default);
            metadata.insert("source".into(), source);
            metadata.insert("name".into(), json!(name));
            attachments.push(attachment);
            if attachments.len() > 8 {
                return Err(Error::Invalid(
                    "command attachments exceed the native eight-part bound".into(),
                ));
            }
        }
        if self.cancel.is_cancelled() {
            return Err(Error::Invalid("command preparation was interrupted".into()));
        }
        if input.command.subtask {
            if self
                .inner
                .store
                .lineage_parent(self.session)
                .await?
                .is_some()
            {
                return Err(Error::Invalid(
                    "nested command subtasks are not supported".into(),
                ));
            }
            let target = target.as_ref().ok_or_else(|| {
                Error::Invalid("command subtask requires a captured agent".into())
            })?;
            let model = input
                .command
                .authority
                .as_ref()
                .and_then(|authority| authority.model.as_ref());
            let call = call_id(&input.input_id, "subtask", 0);
            let child = format!(
                "ses_command_{}",
                crate::permission::digest(
                    format!("{}/{}", self.session, input.input_id).as_bytes()
                )
            );
            let prepared = self
                .inner
                .tools
                .prepare(
                    "task",
                    json!({"prompt":text,"agent":target.name,"session_id":child}),
                )
                .await
                .map_err(|error| Error::Invalid(error.to_string()))?;
            let policy = self.inner.policy.for_agent(parent.as_ref())?;
            self.inner.store.plan_command_call(self.session,self.run,&call,json!({"name":"task","input":prepared.input(),"input_id":input.input_id,"resource":target.name}),self.lease).await?;
            let allowed = authorize(
                self.inner,
                self.session,
                self.run,
                &call,
                &prepared,
                self.cancel.child_token(),
                TurnAuthority {
                    plan: self.plan(parent.as_ref()).await?,
                    policy: &policy,
                    agent: parent.as_ref(),
                },
            )
            .await?;
            if !allowed {
                self.inner
                    .store
                    .finish_command_call(
                        self.session,
                        self.run,
                        &call,
                        Some("command subtask refused".into()),
                        self.lease,
                    )
                    .await?;
                return Err(Error::Invalid("command subtask refused".into()));
            }
            self.inner
                .store
                .dispatch_command_call(self.session, self.run, &call, self.lease)
                .await?;
            let binding = self
                .inner
                .store
                .model_selection(self.session)
                .await?
                .or_else(|| parent.as_ref().and_then(|agent| agent.model.clone()));
            let account = self.inner.store.account_selection(self.session).await?;
            let result = delegate(
                self.inner,
                self.session,
                self.run,
                &call,
                &prepared,
                self.cancel.child_token(),
                Delegation {
                    target: Some(target),
                    referenced_agents: &agents,
                    agent: parent.as_ref(),
                    binding: binding.as_ref(),
                    account: account.as_ref(),
                    model_override: model,
                    attachments: &attachments,
                    agent_references: &input.agent_references.catalog,
                },
            )
            .await;
            self.inner
                .store
                .finish_command_call(
                    self.session,
                    self.run,
                    &call,
                    result.as_ref().err().map(ToString::to_string),
                    self.lease,
                )
                .await?;
            let result = result.map_err(|error| Error::Invalid(error.to_string()))?;
            return Ok(PreparedCommand {
                text: format!(
                    "Command /{} completed in child Session {}:\n{}",
                    input.command.name,
                    result["session_id"].as_str().unwrap_or(""),
                    result["text"].as_str().unwrap_or("")
                ),
                attachments: Vec::new(),
                agents: Vec::new(),
            });
        }
        let mut defaults = input.command.authority.clone().unwrap_or_default();
        if defaults.agent.is_none() && parent.is_none() {
            defaults.agent = target.clone();
        }
        defaults.model = defaults
            .model
            .or_else(|| target.as_ref().and_then(|agent| agent.model.clone()));
        if defaults.agent.is_some() || defaults.model.is_some() {
            let agent = defaults
                .agent
                .as_ref()
                .or(parent.as_ref())
                .or(target.as_ref());
            let binding = defaults
                .model
                .clone()
                .or(self.inner.store.model_selection(self.session).await?)
                .or_else(|| agent.and_then(|agent| agent.model.clone()));
            let binding = match self.inner.store.account_selection(self.session).await? {
                Some(account) => crate::session_account::resolve(
                    &self.inner.provider,
                    binding.as_ref(),
                    account.credential_id.as_deref(),
                )?,
                None => binding,
            };
            let provider = crate::session_model::select(&self.inner.provider, binding.as_ref())?;
            if let Some(request) = agent.and_then(|agent| agent.request.as_ref()) {
                provider
                    .with_request_options(request.clone())
                    .map_err(|error| Error::Invalid(error.to_string()))?;
            }
            crate::session_model::validate_history(
                &self.inner.store.selected_history(self.session).await?,
                binding.as_ref(),
                provider.identity(),
            )?;
            self.inner
                .store
                .command_defaults(self.session, &input.input_id, defaults, self.lease)
                .await?;
        }
        Ok(PreparedCommand {
            text,
            attachments,
            agents,
        })
    }

    async fn plan(&self, agent: Option<&AgentManifest>) -> Result<bool, Error> {
        Ok(
            self.inner.store.mode(self.session).await? == CollaborationMode::Plan
                || agent.is_some_and(|agent| agent.mode == Some(CollaborationMode::Plan)),
        )
    }

    async fn shells(
        &self,
        input: &Pending,
        agent: Option<&AgentManifest>,
    ) -> Result<String, Error> {
        static SHELL: OnceLock<regex::Regex> = OnceLock::new();
        let shell = SHELL
            .get_or_init(|| regex::Regex::new(r"!`([^`]+)`").expect("static shell expression"));
        let matches = shell.captures_iter(&input.text).collect::<Vec<_>>();
        if matches.len() > 32 {
            return Err(Error::Invalid(
                "command has too many shell substitutions".into(),
            ));
        }
        let mut text = String::new();
        let mut offset = 0;
        for (index, capture) in matches.iter().enumerate() {
            let part = capture.get(0).expect("complete shell capture");
            text.push_str(&input.text[offset..part.start()]);
            let call = call_id(&input.input_id, "shell", index);
            self.inner.store.record(self.session,"command.shell",json!({"input_id":input.input_id,"call_id":call,"part":index,"origin":"operator"})).await?;
            let result = super::shell::execute_in_run(
                self.inner,
                self.session,
                self.run,
                crate::session_shell::Invocation {
                    call_id: call,
                    command: capture[1].into(),
                    timeout_ms: 120000,
                },
                self.cancel.child_token(),
                self.lease,
                super::shell::Options {
                    standalone: false,
                    agent: agent.cloned(),
                },
            )
            .await?;
            if result["state"] != "ended"
                || result["result"]["reason"] != "completed"
                || result["result"]["truncated"] == true
            {
                return Err(Error::Invalid("command shell failed, was interrupted, or exceeded its output limit; its side effects were not replayed".into()));
            }
            let output = result["result"]["output"].as_str().unwrap_or("");
            text.push_str(
                output
                    .strip_suffix("\r\n")
                    .or_else(|| output.strip_suffix('\n'))
                    .unwrap_or(output),
            );
            if text.len() > 1024 * 1024 {
                return Err(Error::Invalid(
                    "prepared command text exceeds one MiB".into(),
                ));
            }
            offset = part.end();
        }
        text.push_str(&input.text[offset..]);
        if text.len() > 1024 * 1024 {
            return Err(Error::Invalid(
                "prepared command text exceeds one MiB".into(),
            ));
        }
        Ok(text)
    }
}

fn call_id(input: &str, kind: &str, index: usize) -> String {
    format!(
        "command-{}",
        crate::permission::digest(format!("{input}/{kind}/{index}").as_bytes())
    )
}

fn mentions(text: &str) -> Result<Vec<crate::session_agent::AgentMention>, Error> {
    static MENTION: OnceLock<regex::Regex> = OnceLock::new();
    let mention = MENTION.get_or_init(|| {
        regex::Regex::new(r"@(\.?[^\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}`,.]*(?:\.[^\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}`,.]+)*)").expect("static mention expression")
    });
    let mut names = std::collections::HashSet::new();
    let selected = mention
        .captures_iter(text)
        .filter_map(|capture| {
            let full = capture.get(0)?;
            if text[..full.start()]
                .chars()
                .next_back()
                .is_some_and(|before| before.is_ascii_alphanumeric() || matches!(before, '_' | '`'))
            {
                return None;
            }
            let name = capture.get(1)?.as_str();
            if name.is_empty() || !names.insert(name.to_owned()) {
                return None;
            }
            Some(crate::session_agent::AgentMention {name:name.to_owned(),source:Some(json!({"type":"agent","name":name,"text":full.as_str(),"start":text[..full.start()].encode_utf16().count(),"end":text[..full.end()].encode_utf16().count()}))})
        })
        .collect::<Vec<_>>();
    if selected.len() > 32 {
        return Err(Error::Invalid("command has too many references".into()));
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    #[test]
    fn reference_scanning_matches_the_actual_host_command_corpus() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/command-reference-corpus.json"
        ))
        .unwrap();
        for record in corpus["records"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(super::mentions(record["text"].as_str().unwrap()).unwrap())
                    .unwrap(),
                record["expected"],
                "{}",
                record["text"]
            );
        }
    }
}
