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
            Command::Initialize {
                session_id,
                title,
                protocol,
            } => {
                if protocol != crate::PROTOCOL {
                    return Err(Error::Invalid(format!(
                        "protocol mismatch: client {protocol}, engine {}; refusing to serve this session rather than risk corrupting it",
                        crate::PROTOCOL
                    )));
                }
                runtime.initialize(&session_id, &title).await
            }
            Command::Admit {
                input,
                resume,
                attachments,
            } => runtime
                .admit_with(input, attachments, resume)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Shell {
                session_id,
                call_id,
                command,
                timeout_ms,
            } => {
                runtime
                    .shell(
                        &session_id,
                        crate::session_shell::Invocation {
                            call_id: call_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                            command,
                            timeout_ms,
                        },
                    )
                    .await
            }
            Command::ShellStatus {
                session_id,
                call_id,
            } => runtime.shell_status(&session_id, &call_id).await,
            Command::Inject {
                session_id,
                input_id,
                text,
                source,
            } => runtime.inject(&session_id, input_id, &text, &source).await,
            Command::Wake { session_id } => runtime
                .wake_pending(&session_id)
                .await
                .map(|_| json!({"accepted":true})),
            Command::Resume { session_id } => runtime
                .resume(&session_id)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::Archive {
                session_id,
                archived,
            } => runtime.store().set_archived(&session_id, archived).await,
            Command::Pin { session_id, pinned } => {
                runtime.store().set_pinned(&session_id, pinned).await
            }
            Command::Remove { session_id } => runtime.remove(&session_id).await,
            Command::Recap { session_id } => runtime.recap(&session_id).await,
            Command::RequestCompact {
                session_id,
                through,
                focus,
            } => {
                runtime
                    .request_compact_with(
                        &session_id,
                        crate::protocol::CompactScope { through, focus },
                    )
                    .await
            }
            Command::SelectAgent { session_id, agent } => {
                runtime.set_agent(&session_id, *agent).await
            }
            Command::ForkSession {
                session_id,
                target_session_id,
            } => runtime.fork(&session_id, &target_session_id, None).await,
            Command::PendingInputs {
                session_id,
                after,
                limit,
            } => {
                runtime
                    .store()
                    .pending_inputs(&session_id, after, limit)
                    .await
            }
            Command::CancelInput {
                session_id,
                input_id,
            } => runtime.store().cancel_input(&session_id, &input_id).await,
            Command::InputStatus {
                session_id,
                input_id,
            } => runtime.store().input_status(&session_id, &input_id).await,
            Command::EditInput {
                session_id,
                input_id,
                prompt,
            } => {
                runtime
                    .store()
                    .edit_input(&session_id, &input_id, &prompt)
                    .await
            }
            Command::ModelCatalog => {
                serde_json::to_value(runtime.model_catalog()).map_err(Error::from)
            }
            Command::ProviderCatalog => {
                serde_json::to_value(runtime.provider_catalog()).map_err(Error::from)
            }
            Command::SelectModel {
                session_id,
                binding,
            } => runtime.select_model(&session_id, binding).await,
            Command::SelectAccount {
                session_id,
                credential_id,
            } => runtime.select_account(&session_id, credential_id).await,
            Command::Recoveries { session_id, after } => {
                runtime.store().recoveries(&session_id, &after).await
            }
            Command::TimerSessions => runtime
                .store()
                .timer_sessions()
                .await
                .map(|sessions| serde_json::json!({"sessions": sessions })),
            Command::ResolveRecovery {
                session_id,
                call_id,
                operation_id,
                decision,
                resume,
            } => {
                runtime
                    .resolve_recovery(&session_id, &call_id, &operation_id, decision, resume)
                    .await
            }
            Command::RecoveryGet {
                session_id,
                call_id,
            } => runtime.store().recovery_get(&session_id, &call_id).await,
            Command::Mode { session_id, mode } => runtime
                .set_mode(&session_id, mode)
                .await
                .map(|_| json!({ "accepted": true, "mode": mode })),
            Command::Rename { session_id, title } => runtime
                .store()
                .rename(&session_id, &title)
                .await
                .map(|_| json!({ "accepted": true, "title": title })),
            Command::Tag { session_id, tag } => runtime
                .store()
                .tag(&session_id, &tag)
                .await
                .map(|_| json!({ "accepted": true, "tag": tag })),
            Command::Cancel { session_id } => runtime
                .cancel(&session_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::CancelIf { session_id, run_id } => runtime
                .cancel_if(&session_id, &run_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::Compact {
                session_id,
                compaction_id,
                through_message_seq,
                summary,
            } => {
                let result = runtime
                    .store()
                    .compact(&session_id, &compaction_id, through_message_seq, summary)
                    .await;
                // An explicit operator compact also closes the automatic
                // trigger's breaker, so a failing summarizer gets a fresh try.
                if result.is_ok() {
                    runtime.reset_compaction_breaker().await;
                }
                result
            }
            Command::Recall {
                session_id,
                query,
                limit,
                before_message_seq,
                tool_use_id,
                offset,
            } => {
                runtime
                    .store()
                    .recall(
                        &session_id,
                        crate::recall::Query {
                            query,
                            limit,
                            before_message_seq,
                            tool_use_id,
                            offset,
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
            Command::RejectQuestion {
                session_id,
                rejection,
            } => runtime
                .reject_question(&self.controller, &session_id, rejection)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::ConfigReload => runtime.reload_config().await,
            Command::ConfigNormalized => runtime.normalized_config().await,
            Command::State { session_id } => runtime.store().state(&session_id).await,
            Command::Usage { session_id } => runtime.store().usage_report(&session_id).await,
            Command::UsageHourly { hours } => runtime.store().usage_hourly(hours).await,
            Command::VcsStatus { session_id } => runtime.store().vcs_status(&session_id).await,
            Command::VcsDiff { session_id, path } => {
                runtime.store().vcs_diff(&session_id, &path).await
            }
            Command::MoveSession {
                session_id,
                target_directory,
            } => {
                let product = std::env::var("MIAO_PRODUCT_DATABASE").map_err(|_| {
                    Error::Invalid("move-session requires the host's product database".into())
                })?;
                let bundle = std::env::temp_dir().join(format!(
                    "miao-move-{}-{}.bundle",
                    std::process::id(),
                    session_id
                ));
                let result = runtime
                    .store()
                    .export_session_move(
                        &session_id,
                        std::path::Path::new(&product),
                        &target_directory,
                        bundle.clone(),
                    )
                    .await;
                let _ = tokio::fs::remove_file(&bundle).await;
                result
            }
            Command::Workspaces => Ok(parse_export(
                std::env::var("MIAO_WORKSPACES_JSON").ok().as_deref(),
            )),
            Command::Worktrees { root } => {
                Ok(json!(crate::worktree::list(std::path::Path::new(&root))?))
            }
            Command::WorktreeCreate { root, name } => Ok(json!(crate::worktree::create(
                std::path::Path::new(&root),
                &name
            )?)),
            Command::WorktreeRemove { root, name, force } => {
                let checkout = std::path::Path::new(&root);
                let tree = checkout.join(crate::worktree::DIRECTORY).join(&name);
                let ledger = runtime.store().path().to_path_buf();
                // A tree can anchor Sessions in its own ledger, which the
                // checkout's ledger never sees: the tree was worked in before
                // any Session moved into it. Read both, so the count matches
                // what `miao worktree remove` plans.
                let tree_ledger = crate::placement::default_database(&tree);
                let anchored = crate::worktree::anchored_sessions(&ledger, &tree)?
                    + match tree_ledger.as_deref() {
                        Some(tree_ledger) if tree_ledger != ledger => {
                            crate::worktree::anchored_sessions(tree_ledger, &tree)?
                        }
                        _ => 0,
                    };
                // Removing a tree whose Sessions are still working there leaves
                // their tools pointing at a directory that no longer exists, so
                // the refusal names the count and the way out.
                if anchored > 0 && !force {
                    return Err(Error::Invalid(format!(
                        "{anchored} session(s) still anchor {}: move or close them first, or pass force to point them back at the checkout",
                        tree.display()
                    )));
                }
                if anchored > 0 {
                    runtime
                        .store()
                        .repoint_root(tree.clone(), checkout.to_path_buf())
                        .await?;
                    if let Some(tree_ledger) = tree_ledger.as_deref() {
                        crate::worktree::repoint_sessions(tree_ledger, &tree, checkout)?;
                    }
                }
                crate::worktree::remove(checkout, &name)?;
                Ok(json!({ "removed": name, "migrated": anchored }))
            }
            Command::Devices => Ok(parse_export(
                std::env::var("MIAO_DEVICES_JSON").ok().as_deref(),
            )),
            Command::SessionChildren { session_id } => {
                runtime
                    .store()
                    .children(&session_id, crate::children::MAX_CHILDREN)
                    .await
            }
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
            Command::HistoryPage {
                session_id,
                before_seq,
                limit,
            } => {
                runtime
                    .store()
                    .history_page(&session_id, before_seq, limit)
                    .await
            }
            Command::Job { session_id, job_id } => runtime
                .store()
                .job(&session_id, &job_id)
                .await
                .map(|value| value.unwrap_or(Value::Null)),
            Command::Jobs { session_id } => {
                let jobs = runtime.store().jobs(&session_id).await?;
                // One answer serves the whole dialog: the Session's jobs
                // beside its subagent runs, so a client costs one round trip
                // instead of composing two reads. A children read fails only
                // for an unknown Session, and the jobs above already answered
                // that Session's rows, so the side list empties instead of
                // failing the answer.
                let subagents = runtime
                    .store()
                    .children(&session_id, crate::children::MAX_CHILDREN)
                    .await
                    .map(|children| subagent_rows(&children))
                    .unwrap_or_default();
                Ok(json!({ "jobs": jobs, "subagents": subagents }))
            }
            Command::CancelJob { session_id, job_id } => runtime
                .cancel_job(&session_id, &job_id)
                .await
                .map(|accepted| json!({ "accepted": accepted })),
            Command::StopAllJobs { session_id } => runtime
                .stop_all_jobs(&session_id)
                .await
                .map(|stopped| json!({ "stopped": stopped })),
            Command::Context { session_id, epoch } => runtime
                .store()
                .context(&session_id, epoch)
                .await
                .map(|value| value.unwrap_or(Value::Null)),
            Command::Snapshot {
                session_id,
                metadata_only,
            } => {
                runtime
                    .store()
                    .snapshot_with_metadata(&session_id, metadata_only)
                    .await
            }
            Command::TransferValidate {
                path,
                bundle_sha256,
                identity,
                route_id,
                agent,
            } => {
                let bundle = crate::transfer::read_bundle_file(path, &bundle_sha256).await?;
                let preparation =
                    crate::transfer_activation::prepare(&bundle, identity, route_id, agent)?;
                runtime.validate_transfer_preparation(&preparation)?;
                Ok(
                    json!({"bundle_sha256":bundle_sha256,"identity":preparation.identity,"route_id":preparation.route_id,"message_count":preparation.messages.len()}),
                )
            }
            Command::TransferStage {
                import_id,
                path,
                bundle_sha256,
                identity,
                route_id,
                agent,
            } => {
                let bundle = crate::transfer::read_bundle_file(path, &bundle_sha256).await?;
                let preparation = crate::transfer_activation::prepare(
                    &bundle,
                    identity.clone(),
                    route_id.clone(),
                    agent.clone(),
                )?;
                runtime.validate_transfer_preparation(&preparation)?;
                let staged = runtime
                    .store()
                    .stage_transfer_with_agent(
                        &import_id,
                        bundle,
                        &bundle_sha256,
                        identity,
                        route_id,
                        agent,
                    )
                    .await?;
                Ok(
                    json!({"id":staged.id,"session_id":staged.session_id,"bundle_sha256":staged.bundle_sha256,"state":staged.state}),
                )
            }
            Command::TransferActivate {
                import_id,
                bundle_sha256,
                product_database,
            } => {
                runtime
                    .activate_transfer(&import_id, &bundle_sha256, &product_database)
                    .await
            }
            Command::TransferExport { import_id, path } => {
                runtime
                    .store()
                    .export_session_transfer_import(&import_id, path)
                    .await
            }
            Command::TransferExportMove {
                session_id,
                product_database,
                target_directory,
                path,
            } => {
                runtime
                    .store()
                    .export_session_move(&session_id, &product_database, &target_directory, path)
                    .await
            }
            Command::TransferStageNative {
                import_id,
                path,
                bundle_sha256,
                identity,
                route_id,
                agent,
            } => {
                let bundle = crate::transfer::read_bundle_file(path, &bundle_sha256).await?;
                let preparation = crate::transfer_activation::prepare_native(
                    &bundle,
                    identity.clone(),
                    route_id.clone(),
                    agent.clone(),
                )?;
                runtime.validate_transfer_preparation(&preparation)?;
                let staged = runtime
                    .store()
                    .stage_transfer_with_preparation(
                        &import_id,
                        bundle,
                        &bundle_sha256,
                        preparation,
                    )
                    .await?;
                Ok(
                    json!({"id":staged.id,"session_id":staged.session_id,"bundle_sha256":staged.bundle_sha256,"state":staged.state}),
                )
            }
            Command::TransferExportDelta {
                import_id,
                session_id,
                path,
            } => {
                runtime
                    .store()
                    .export_session_transfer_delta(&import_id, session_id.as_deref(), path)
                    .await
            }
            Command::TransferAbort { import_id } => {
                runtime
                    .store()
                    .abort_session_transfer_import(&import_id)
                    .await?;
                Ok(json!({"id":import_id,"state":"aborted"}))
            }
            Command::TransferTimeline { session_id, after } => {
                runtime
                    .store()
                    .transfer_messages(&session_id, after, false, u64::MAX)
                    .await
            }
            Command::TransferContext {
                session_id,
                after,
                cursor,
            } => {
                runtime
                    .store()
                    .transfer_messages(&session_id, after, true, cursor.unwrap_or(u64::MAX))
                    .await
            }
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
            Command::RevertStage {
                session_id,
                boundary_seq,
                files,
            } => {
                runtime
                    .store()
                    .revert_stage(&session_id, boundary_seq, files)
                    .await
            }
            Command::RevertPreview {
                session_id,
                boundary_seq,
            } => {
                runtime
                    .store()
                    .revert_preview(&session_id, boundary_seq)
                    .await
            }
            Command::RevertClear { session_id } => runtime.store().revert_clear(&session_id).await,
            Command::RevertCommit { session_id } => {
                runtime.store().revert_commit(&session_id).await
            }
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
            Command::ProductPermissionEvaluate { source, request } => runtime
                .evaluate_product_permission(&self.controller, &source, request)
                .await
                .and_then(|outcome| serde_json::to_value(outcome).map_err(Error::from)),
            Command::PermissionEvaluate { request } => {
                if request.actions.is_empty() || request.resources.is_empty() {
                    return Err(Error::Invalid(
                        "permission_evaluate requires actions and resources".into(),
                    ));
                }
                serde_json::to_value(crate::permission_rules::evaluate(&request)?)
                    .map_err(Error::from)
            }
            Command::ProductPermissionAdmit { source, input } => runtime
                .admit_product_permission(&self.controller, &source, input)
                .await
                .and_then(|record| serde_json::to_value(record).map_err(Error::from)),
            Command::ProductPermissionStatus { source, request_id } => runtime
                .product_permission_status(&self.controller, &source, request_id)
                .await
                .and_then(|record| serde_json::to_value(record).map_err(Error::from)),
            Command::ProductPermissionCancel { source, request_id } => runtime
                .cancel_product_permission(&self.controller, &source, request_id)
                .await
                .and_then(|record| serde_json::to_value(record).map_err(Error::from)),
            Command::ProductPermissionReply { source, response } => runtime
                .reply_product_permission(&self.controller, &source, response)
                .await
                .and_then(|record| serde_json::to_value(record).map_err(Error::from)),
            Command::ProductPermissionPending { session_id } => runtime
                .pending_product_permissions(&self.controller, session_id)
                .await
                .and_then(|records| serde_json::to_value(records).map_err(Error::from)),
            Command::SharedPermissionSnapshot => runtime
                .shared_permission_snapshot(&self.controller)
                .await
                .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Error::from)),
            Command::SharedPermissionChanges(input) => runtime
                .shared_permission_changes(&self.controller, input)
                .await
                .and_then(|page| serde_json::to_value(page).map_err(Error::from)),
            Command::PermissionImportSnapshot => runtime
                .permission_import_snapshot(&self.controller)
                .await
                .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Error::from)),
            Command::PermissionImportChanges(input) => runtime
                .permission_import_changes(&self.controller, input)
                .await
                .and_then(|page| serde_json::to_value(page).map_err(Error::from)),
            Command::PermissionSavedMigrate(input) => runtime
                .migrate_saved_permissions(&self.controller, input)
                .await
                .and_then(|receipt| serde_json::to_value(receipt).map_err(Error::from)),
            Command::PermissionSavedMigration => runtime
                .saved_permission_migration(&self.controller)
                .await
                .and_then(|receipt| serde_json::to_value(receipt).map_err(Error::from)),
            Command::PermissionSavedImported => runtime
                .imported_permissions(&self.controller)
                .await
                .and_then(|rules| serde_json::to_value(rules).map_err(Error::from)),
            Command::PermissionSavedRemove(input) => runtime
                .remove_imported_permission(&self.controller, input.id)
                .await
                .map(|removed| json!({"removed":removed})),
            Command::PermissionPatternList => runtime
                .permission_patterns(&self.controller)
                .await
                .and_then(|patterns| serde_json::to_value(patterns).map_err(Error::from)),
            Command::PermissionPatternSnapshot => runtime
                .permission_pattern_snapshot(&self.controller)
                .await
                .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Error::from)),
            Command::PermissionPatternChanges(input) => runtime
                .permission_pattern_changes(&self.controller, input)
                .await
                .and_then(|page| serde_json::to_value(page).map_err(Error::from)),
            Command::PermissionPatternPut(input) => runtime
                .put_permission_pattern(&self.controller, input.rule)
                .await
                .and_then(|pattern| serde_json::to_value(pattern).map_err(Error::from)),
            Command::PermissionPatternRemove(input) => runtime
                .remove_permission_pattern(&self.controller, input.rule_id)
                .await
                .map(|removed| json!({"removed":removed})),
            Command::PermissionSavedProject { workspace, rules } => {
                runtime
                    .store()
                    .project_saved_rules(workspace, rules)
                    .await?;
                Ok(json!({ "accepted": true }))
            }
            Command::PermissionSavedSnapshot { workspace, rules } => {
                runtime
                    .replace_saved_rules(&self.controller, workspace, rules)
                    .await?;
                Ok(json!({ "accepted": true }))
            }
            Command::Approve {
                session_id,
                response,
            } => runtime
                .approve(&self.controller, &session_id, response)
                .await
                .map(|_| json!({ "accepted": true })),
            Command::ApprovePersistent {
                session_id,
                response,
            } => runtime
                .approve_persistent(&self.controller, &session_id, response)
                .await
                .map(|_| json!({"accepted":true})),
            Command::Sessions => runtime
                .store()
                .sessions()
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::SessionCatalog => runtime
                .store()
                .session_catalog()
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Shutdown => Ok(json!({ "accepted": true })),
        }
    }

    /// Committed events for every subscription, advancing each cursor. Each
    /// item is the bare event: the adapter owns the envelope, so a frame is
    /// wrapped exactly once on its way to a client. Returning the envelope from
    /// here let the in-process adapter wrap it again, and the doubly nested
    /// frame could not decode into an event and was dropped — every durable
    /// notification vanished, so the transcript refreshed only when a timer
    /// happened to re-project. The durable cursor keeps the replay→live
    /// handoff gapless.
    pub async fn poll_events(&mut self) -> Result<Vec<Value>, Error> {
        let runtime = &self.runtime;
        let mut notifications = Vec::new();
        for (session, cursor) in self.subscriptions.iter_mut() {
            for event in runtime.store().events(session, *cursor, 32).await? {
                *cursor = event.seq;
                notifications.push(serde_json::to_value(event).map_err(Error::from)?);
            }
        }
        Ok(notifications)
    }
}

/// The subagent side of a `jobs` answer: the Session's delegated children, one
/// row each, named the way the jobs rows are so one list shape serves both. A
/// child is another Session, so its row stays read-only in the dialog — the
/// stop commands name jobs, never children.
fn subagent_rows(children: &Value) -> Vec<Value> {
    children
        .get("children")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("session_id")?.as_str()?;
                    Some(json!({
                        "id": id,
                        "session_id": children.get("session_id"),
                        "status": row.get("status"),
                        "description": row.get("title"),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The host prepares a read-only list (workspaces, devices) and exports it as
/// JSON. A missing or malformed export is an empty list: the panel shows
/// nothing instead of failing the request.
fn parse_export(raw: Option<&str>) -> Value {
    raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_array)
        .unwrap_or_else(|| json!([]))
}

#[cfg(test)]
mod export_tests {
    use super::parse_export;
    use serde_json::json;

    #[test]
    fn the_host_export_is_served_verbatim() {
        let parsed = parse_export(Some(r#"[{"name":"main","detail":"main"}]"#));
        assert_eq!(parsed, json!([{ "name": "main", "detail": "main" }]));
    }

    #[test]
    fn a_missing_or_malformed_export_is_an_empty_list() {
        assert_eq!(parse_export(None), json!([]));
        assert_eq!(parse_export(Some("not json")), json!([]));
        assert_eq!(parse_export(Some("{}")), json!([]));
    }
}
