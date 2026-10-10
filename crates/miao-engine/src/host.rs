//! Transport-agnostic host dispatch.
//!
//! Every wire adapter maps its own envelope onto the [`Command`] vocabulary and
//! runs it through [`Host`]. The domain operations, controller authority and
//! subscription cursors live here, so an adapter owns only its framing.

use crate::{
    protocol::{Command, Error},
    runtime::{Controller, Runtime},
};
use serde_json::{json, Value};
use std::collections::HashMap;

/// One attached client's command surface over a single [`Runtime`].
///
/// The controller capability is created here and never accepted from the wire:
/// a network adapter must authenticate before it constructs a `Host`.
pub struct Host {
    runtime: Runtime,
    controller: Controller,
    subscriptions: HashMap<String, u64>,
}

impl Host {
    pub fn new(runtime: Runtime) -> Self {
        let controller = runtime.controller();
        Self {
            runtime,
            controller,
            subscriptions: HashMap::new(),
        }
    }

    /// Whether `session` has an active committed-event subscription.
    pub fn subscribed(&self, session: &str) -> bool {
        self.subscriptions.contains_key(session)
    }

    /// Run one command against the runtime. The response carries no request id:
    /// the adapter owns the envelope.
    pub async fn dispatch(&mut self, command: Command) -> Result<Value, Error> {
        let runtime = &self.runtime;
        match command {
            Command::Admit {
                input,
                resume,
                attachments,
            } => runtime
                .admit_with(input, attachments, resume)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Resume { session_id } => runtime
                .resume(&session_id)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::Mode { session_id, mode } => runtime
                .set_mode(&session_id, mode)
                .await
                .map(|_| json!({ "accepted": true, "mode": mode })),
            Command::Cancel { session_id } => runtime
                .cancel(&session_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::Compact {
                session_id,
                compaction_id,
                through_message_seq,
                summary,
            } => {
                runtime
                    .store()
                    .compact(&session_id, &compaction_id, through_message_seq, summary)
                    .await
            }
            Command::Recall {
                session_id,
                query,
                limit,
                before_message_seq,
            } => {
                runtime
                    .store()
                    .recall(
                        &session_id,
                        crate::recall::Query {
                            query,
                            limit,
                            before_message_seq,
                        },
                    )
                    .await
            }
            Command::Crons { session_id } => runtime
                .store()
                .crons(&session_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::CancelCron {
                session_id,
                cron_id,
            } => runtime
                .cancel_cron(&session_id, &cron_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::Wakeups { session_id } => runtime
                .store()
                .wakeups(&session_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::CancelWakeup {
                session_id,
                timer_id,
            } => runtime
                .cancel_wakeup(&session_id, &timer_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::Questions { session_id } => runtime
                .store()
                .questions(&session_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::AnswerQuestion { session_id, answer } => runtime
                .answer_question(&self.controller, &session_id, answer)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::State { session_id } => runtime.store().state(&session_id).await,
            Command::UpdateState {
                session_id,
                operation_id,
                tool,
                input,
            } => match crate::state::Mutation::parse(&tool, input) {
                Ok(mutation) => {
                    runtime
                        .store()
                        .update_state(&session_id, &operation_id, mutation)
                        .await
                }
                Err(_) => Err(Error::Invalid("invalid Session state update".into())),
            },
            Command::History {
                session_id,
                selected,
            } => {
                let history = if selected {
                    runtime.store().selected_history(&session_id).await
                } else {
                    runtime.store().history(&session_id).await
                };
                history.and_then(|value| serde_json::to_value(value).map_err(Error::from))
            }
            Command::Job { session_id, job_id } => runtime
                .store()
                .job(&session_id, &job_id)
                .await
                .map(|value| value.unwrap_or(Value::Null)),
            Command::Jobs { session_id } => runtime
                .store()
                .jobs(&session_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::CancelJob { session_id, job_id } => runtime
                .cancel_job(&session_id, &job_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::Context { session_id, epoch } => runtime
                .store()
                .context(&session_id, epoch)
                .await
                .map(|value| value.unwrap_or(Value::Null)),
            Command::Snapshot { session_id } => runtime.store().snapshot(&session_id).await,
            Command::Fork {
                session_id,
                target_session_id,
                message_seq,
            } => {
                runtime
                    .fork(&session_id, &target_session_id, message_seq)
                    .await
            }
            Command::Revert {
                session_id,
                checkpoint,
            } => runtime.store().revert(&session_id, &checkpoint).await,
            Command::Unrevert { session_id } => runtime.store().unrevert(&session_id).await,
            Command::Events { session_id, after } => runtime
                .store()
                .events(&session_id, after, 100)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Subscribe { session_id, after } => {
                if self.subscriptions.len() >= 64 && !self.subscriptions.contains_key(&session_id) {
                    Err(Error::Invalid("subscription limit".into()))
                } else {
                    self.subscriptions.insert(session_id, after);
                    Ok(json!({ "accepted": true }))
                }
            }
            Command::Unsubscribe { session_id } => {
                self.subscriptions.remove(&session_id);
                Ok(json!({ "accepted": true }))
            }
            Command::Approve {
                session_id,
                response,
            } => runtime
                .approve(&self.controller, &session_id, response)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::Sessions => runtime
                .store()
                .sessions()
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Shutdown => Ok(json!({ "accepted": true })),
        }
    }

    /// Committed event notifications for every subscription, advancing each
    /// cursor. Adapters page these into their own envelope; the durable cursor
    /// keeps the replay→live handoff gapless.
    pub async fn poll_events(&mut self) -> Result<Vec<Value>, Error> {
        let runtime = &self.runtime;
        let mut notifications = Vec::new();
        for (session, cursor) in self.subscriptions.iter_mut() {
            for event in runtime.store().events(session, *cursor, 32).await? {
                *cursor = event.seq;
                notifications.push(json!({ "method": "event", "params": event }));
            }
        }
        Ok(notifications)
    }
}
