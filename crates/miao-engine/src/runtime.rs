use crate::{
    approval::{now_ms, Approval, Response},
    permission::{input_digest, Config, Decision, Policy},
    protocol::{Admission, Error, Input, ModelRequest},
    provider::{Provider, ProviderError},
    store::{RuntimeLease, Store},
    tools::{Prepared, ToolError, Tools},
};
use chrono::TimeZone;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

/// An in-process adapter capability, never accepted as a client-supplied role.
#[derive(Clone)]
pub struct Controller {
    runtime_id: String,
}

struct Inner {
    id: String,
    _lease: RuntimeLease,
    policy: Policy,
    store: Store,
    provider: Arc<dyn Provider>,
    tools: Tools,
    actors: Mutex<HashMap<String, Actor>>,
    jobs: Mutex<HashMap<String, Background>>,
    timers: Mutex<HashMap<String, Background>>,
    crons: Mutex<HashMap<String, Background>>,
    job_slots: Arc<Semaphore>,
    slots: Arc<Semaphore>,
    stop: CancellationToken,
    progress: broadcast::Sender<Value>,
}

struct Actor {
    commands: mpsc::Sender<Command>,
    join: JoinHandle<()>,
}

struct Background {
    session: String,
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

enum Command {
    Wake(bool),
    Cancel(oneshot::Sender<bool>),
    Approve(Response, oneshot::Sender<Result<(), Error>>),
}

impl Runtime {
    pub async fn new(
        store: Store,
        provider: Arc<dyn Provider>,
        tools: Tools,
    ) -> Result<Self, Error> {
        Self::with_policy(store, provider, tools, Policy::new(Config::default())?).await
    }

    pub async fn with_policy(
        store: Store,
        provider: Arc<dyn Provider>,
        tools: Tools,
        policy: Policy,
    ) -> Result<Self, Error> {
        if policy.process_enabled()
            && store
                .path()
                .starts_with(std::path::Path::new(tools.location()))
        {
            return Err(Error::Invalid(
                "process-enabled runtime requires its database outside the workspace".into(),
            ));
        }
        if tools.has_mcp() && !policy.mcp_enabled() {
            return Err(Error::Invalid(
                "MCP services require explicit workspace external authority".into(),
            ));
        }
        let mut tools = tools
            .with_cron(policy.cron_enabled())
            .with_wakeup(policy.wakeup_enabled())
            .with_writes(policy.writes_enabled())
            .with_process(policy.process_enabled(), policy.process_network())
            .with_background(policy.background_enabled())
            .protect_store(store.path());
        for path in provider.protected_resources() {
            let path = tokio::fs::canonicalize(path).await?;
            if policy.process_enabled() && path.starts_with(std::path::Path::new(tools.location()))
            {
                return Err(Error::Invalid(
                    "process credential resources must be outside workspace".into(),
                ));
            }
            tools = tools.with_protected_resource(&path);
        }
        let lease = store.claim_runtime()?;
        store.recover().await?;
        store.recover_jobs().await?;
        store.recover_questions().await?;
        store.recover_wakeups().await?;
        store.recover_crons().await?;
        let (progress, _) = broadcast::channel(256);
        Ok(Self {
            inner: Arc::new(Inner {
                id: uuid::Uuid::new_v4().to_string(),
                _lease: lease,
                policy,
                store,
                provider,
                tools,
                actors: Mutex::new(HashMap::new()),
                jobs: Mutex::new(HashMap::new()),
                timers: Mutex::new(HashMap::new()),
                crons: Mutex::new(HashMap::new()),
                job_slots: Arc::new(Semaphore::new(2)),
                slots: Arc::new(Semaphore::new(8)),
                stop: CancellationToken::new(),
                progress,
            }),
        })
    }

    pub fn controller(&self) -> Controller {
        Controller {
            runtime_id: self.inner.id.clone(),
        }
    }

    pub async fn approve(
        &self,
        controller: &Controller,
        session: &str,
        response: Response,
    ) -> Result<(), Error> {
        if controller.runtime_id != self.inner.id
            || response.policy_revision != self.inner.policy.revision()
        {
            return Err(Error::ApprovalMismatch);
        }
        let commands = {
            let actors = self.inner.actors.lock().await;
            actors.get(session).map(|a| a.commands.clone())
        };
        let commands = commands.ok_or(Error::ApprovalResolved)?;
        let (send, receive) = oneshot::channel();
        commands
            .send(Command::Approve(response, send))
            .await
            .map_err(|_| Error::Closed)?;
        receive.await.map_err(|_| Error::Closed)?
    }

    pub async fn answer_question(
        &self,
        controller: &Controller,
        session: &str,
        answer: crate::question::Answer,
    ) -> Result<(), Error> {
        if controller.runtime_id != self.inner.id {
            return Err(Error::Invalid("question controller mismatch".into()));
        }
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Invalid("question Location mismatch".into()));
        }
        self.inner.store.answer_question(session, answer).await
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    /// Ephemeral deltas have no durable cursor. Slow clients lose deltas and
    /// resynchronize from committed messages, never block provider execution.
    pub fn progress(&self) -> broadcast::Receiver<Value> {
        self.inner.progress.subscribe()
    }

    pub async fn admit(&self, input: Input, resume: bool) -> Result<Admission, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        let session = input.session_id.clone();
        let admission = self
            .inner
            .store
            .admit_at(input, Some(self.inner.tools.location().to_owned()))
            .await?;
        // An exact retry may repair a lost advisory wake for pending input,
        // but never restarts promoted/completed provider work.
        if resume && admission.pending {
            self.wake(&session, false).await?;
        }
        Ok(admission)
    }

    pub async fn fork(
        &self,
        parent: &str,
        target: &str,
        message_seq: Option<u64>,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(parent).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        self.inner.store.fork(parent, target, message_seq).await
    }

    pub async fn resume(&self, session: &str) -> Result<(), Error> {
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        self.wake(session, true).await
    }

    async fn wake(&self, session: &str, force: bool) -> Result<(), Error> {
        let commands = self.actor(session).await?;
        tokio::select! {
            _=self.inner.stop.cancelled() => Err(Error::Closed),
            result=commands.send(Command::Wake(force)) => result.map_err(|_|Error::Closed),
        }
    }

    async fn actor(&self, session: &str) -> Result<mpsc::Sender<Command>, Error> {
        let mut actors = self.inner.actors.lock().await;
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if let Some(actor) = actors.get(session) {
            return Ok(actor.commands.clone());
        }
        if actors.len() >= 64 {
            return Err(Error::Invalid(
                "M0 runtime supports at most 64 attached Sessions".into(),
            ));
        }
        let (commands, receive) = mpsc::channel(32);
        let join = tokio::spawn(coordinate(session.to_owned(), self.inner.clone(), receive));
        actors.insert(
            session.to_owned(),
            Actor {
                commands: commands.clone(),
                join,
            },
        );
        Ok(commands)
    }

    pub async fn cancel(&self, session: &str) -> Result<bool, Error> {
        let commands = {
            let actors = self.inner.actors.lock().await;
            actors.get(session).map(|a| a.commands.clone())
        };
        let Some(commands) = commands else {
            return Ok(false);
        };
        let (reply, result) = oneshot::channel();
        commands
            .send(Command::Cancel(reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)
    }

    pub async fn cancel_job(&self, session: &str, id: &str) -> Result<bool, Error> {
        cancel_background(&self.inner, session, id).await
    }

    pub async fn cancel_cron(&self, session: &str, id: &str) -> Result<bool, Error> {
        cancel_cron(&self.inner, session, id).await
    }

    pub async fn cancel_wakeup(&self, session: &str, id: &str) -> Result<bool, Error> {
        cancel_wakeup(&self.inner, session, id).await
    }

    pub async fn shutdown(&self) {
        self.inner.stop.cancel();
        let actors = std::mem::take(&mut *self.inner.actors.lock().await);
        for (_, actor) in actors {
            let _ = actor.join.await;
        }
        let jobs = std::mem::take(&mut *self.inner.jobs.lock().await);
        for (_, job) in jobs {
            job.cancel.cancel();
            let _ = job.join.await;
        }
        let timers = std::mem::take(&mut *self.inner.timers.lock().await);
        for (_, timer) in timers {
            timer.cancel.cancel();
            let _ = timer.join.await;
        }
        let crons = std::mem::take(&mut *self.inner.crons.lock().await);
        for (_, cron) in crons {
            cron.cancel.cancel();
            let _ = cron.join.await;
        }
        self.inner.tools.shutdown_extensions().await;
    }
}

async fn coordinate(session: String, inner: Arc<Inner>, mut commands: mpsc::Receiver<Command>) {
    let mut tasks = JoinSet::new();
    let mut active: Option<CancellationToken> = None;
    let mut wake = None;
    loop {
        if active.is_none() {
            if let Some(force) = wake.take() {
                let cancel = inner.stop.child_token();
                active = Some(cancel.clone());
                let (session, inner) = (session.clone(), inner.clone());
                tasks.spawn(async move { drain(session, inner, force, cancel).await });
            }
        }
        tokio::select! {
            biased;
            _=inner.stop.cancelled() => {
                if let Some(cancel)=active.take() { cancel.cancel(); }
                while tasks.join_next().await.is_some() {}
                break;
            }
            command=commands.recv() => match command {
                Some(Command::Wake(force)) => wake=Some(wake.unwrap_or(false)||(force && active.is_none())),
                Some(Command::Cancel(reply)) => {
                    wake=None;
                    if let Some(cancel)=&active { cancel.cancel(); }
                    let _=reply.send(active.is_some());
                }
                Some(Command::Approve(response,reply))=>{
                    let result=if active.as_ref().is_none_or(|token|token.is_cancelled()){Err(Error::ApprovalResolved)}else{inner.store.resolve_approval(&session,response).await.map(|_|())};
                    let _=reply.send(result);
                },
                None => break,
            },
            result=tasks.join_next(), if active.is_some() => {
                active=None;
                match result {
                    Some(Ok(Ok(()))) => {},
                    Some(Ok(Err(error))) => { let _=inner.progress.send(json!({"session_id":session,"kind":"runtime.error","code":error.code(),"message":error.to_string()})); },
                    Some(Err(_)) => {
                        // Panics do not become silent hung actors. The durable
                        // active execution is reconciled before another wake.
                        let _=inner.store.recover_session(Some(&session)).await;
                        let _=inner.progress.send(json!({"session_id":session,"kind":"runtime.error","code":"task_panicked"}));
                    }
                    None => {},
                }
            },
        }
    }
}

async fn drain(
    session: String,
    inner: Arc<Inner>,
    force: bool,
    cancel: CancellationToken,
) -> Result<(), Error> {
    let _slot = tokio::select! {
        _=cancel.cancelled()=>return Ok(()),
        permit=inner.slots.clone().acquire_owned()=>permit.map_err(|_|Error::Closed)?,
    };
    let promoted = inner.store.promote(&session, true).await?;
    if promoted.is_empty() && !force {
        return Ok(());
    }
    if inner.store.history(&session).await?.is_empty() {
        return Err(Error::Invalid("Session has no admitted history".into()));
    }
    let run = uuid::Uuid::new_v4().to_string();
    inner.store.start_run(&session, &run).await?;
    let result = execute(&session, &run, &inner, cancel.clone()).await;
    let reason = if cancel.is_cancelled() {
        "interrupted"
    } else if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    inner.store.finish_run(&session, &run, reason).await?;
    result
}

async fn execute(
    session: &str,
    run: &str,
    inner: &Arc<Inner>,
    cancel: CancellationToken,
) -> Result<(), Error> {
    let mut step = 0;
    let mut allowance = 25;
    let mut repeats = HashMap::<String, u32>::new();
    loop {
        if allowance == 0 {
            return Err(Error::Invalid("provider turn allowance exceeded".into()));
        }
        allowance -= 1;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let bundle =
            match crate::context::assemble(&inner.tools, &inner.policy, cancel.child_token()).await
            {
                Ok(bundle) => bundle,
                Err(ToolError::Interrupted) => return Ok(()),
                Err(error) => {
                    return Err(Error::Invalid(format!("context assembly failed: {error}")))
                }
            };
        if cancel.is_cancelled() {
            return Ok(());
        }
        let system = bundle.system.clone();
        let context_epoch = inner.store.select_context(session, bundle).await?;
        let (mut history, state) = inner.store.selected_input(session).await?;
        let state_allowed = inner.policy.evaluate(
            "session_state",
            "@session/state/session_state",
            crate::permission::Access::Read,
        ) == Decision::Allow;
        let state_selection = if state_allowed {
            if !state["todos"].is_null() || !state["goal"].is_null() {
                let text=format!("<session-state>\n{}\n</session-state>\nCurrent durable progress tracking; recorded evidence is a claim, not independent verification. Follow the latest user request.",serde_json::to_string(&state)?);
                if serde_json::to_vec(&history)?.len() + text.len() > 2 * 1024 * 1024 {
                    return Err(Error::Invalid(
                        "selected input including Session state exceeds budget".into(),
                    ));
                }
                history.insert(
                    0,
                    crate::protocol::Message {
                        role: "user".into(),
                        content: json!([{"type":"text","text":text}]),
                    },
                );
            }
            json!({"status":"selected","todos_revision":state["todos"]["revision"],"goal_revision":state["goal"]["revision"],"fingerprint":crate::permission::digest(&serde_json::to_vec(&state)?)})
        } else {
            json!({"status":"skipped","reason":"state_read_policy"})
        };
        inner
            .store
            .record(
                session,
                "provider.started",
                json!({"run_id":run,"step":step,"context_epoch":context_epoch,"policy_revision":inner.policy.revision(),"state_selection":state_selection}),
            )
            .await?;
        let (send, mut receive) = mpsc::channel(64);
        let response = inner.provider.stream(
            ModelRequest {
                system,
                messages: history,
                tools: inner.tools.definitions(),
            },
            send,
            cancel.child_token(),
        );
        tokio::pin!(response);
        let reply = loop {
            tokio::select! {
                _=cancel.cancelled()=>return Ok(()),
                reply=&mut response=>break reply,
                Some(delta)=receive.recv()=>{ let _=inner.progress.send(json!({"session_id":session,"run_id":run,"step":step,"kind":"provider.delta","data":delta})); },
            }
        };
        let reply = match reply {
            Ok(reply) => reply,
            Err(ProviderError::Interrupted) => return Ok(()),
            Err(error) => {
                inner
                    .store
                    .record(
                        session,
                        "provider.failed",
                        json!({"run_id":run,"step":step,"message":error.to_string(),"routing":error.routing()}),
                    )
                    .await?;
                return Err(Error::Invalid(error.to_string()));
            }
        };
        inner
            .store
            .record(
                session,
                "usage",
                json!({"run_id":run,"step":step,"usage":reply.usage}),
            )
            .await?;
        inner
            .store
            .assistant_reply(session, run, reply.content.clone())
            .await?;
        if reply.needs_tools {
            for block in reply
                .content
                .as_array()
                .ok_or_else(|| Error::Invalid("assistant content".into()))?
            {
                if block["type"] != "tool_use" {
                    continue;
                }
                if cancel.is_cancelled() {
                    return Ok(());
                }
                let id = block["id"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool id".into()))?;
                let name = block["name"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool name".into()))?;
                let prepared = inner.tools.prepare(name, block["input"].clone()).await;
                let (output, is_error) = match prepared {
                    Err(error) => (json!({"error":error.to_string()}), true),
                    Ok(prepared) => {
                        let allowed =
                            authorize(inner, session, run, id, &prepared, cancel.child_token())
                                .await?;
                        if cancel.is_cancelled() {
                            return Ok(());
                        }
                        if !allowed {
                            (json!({"error":"permission denied"}), true)
                        } else if let Some(blocked) =
                            run_hooks(inner, session, crate::hooks::Event::ToolBefore, name).await?
                        {
                            (json!({"error":blocked}), true)
                        } else {
                            inner.store.mark_dispatched(session, run, id).await?;
                            let prepared_external =
                                prepared.access() == crate::permission::Access::External;
                            let executed = match name {
                                "cron_create" => {
                                    start_cron(inner, session, run, id, &prepared).await?
                                }
                                "cron_list" => {
                                    Ok(json!({"crons":inner.store.crons(session).await?}))
                                }
                                "cron_delete" => {
                                    let selector =
                                        crate::cron::Selector::parse(prepared.input().clone())
                                            .map_err(|_| {
                                                Error::Invalid("invalid cron selector".into())
                                            })?;
                                    Ok(
                                        json!({"accepted":cancel_cron(inner,session,&selector.id).await?}),
                                    )
                                }
                                "schedule_wakeup" => {
                                    start_wakeup(inner, session, run, id, &prepared).await?
                                }
                                "cancel_wakeup" => {
                                    let selector =
                                        crate::wakeup::Selector::parse(prepared.input().clone())
                                            .map_err(|_| {
                                                Error::Invalid("invalid wakeup selector".into())
                                            })?;
                                    Ok(
                                        json!({"accepted":cancel_wakeup(inner,session,&selector.timer_id).await?}),
                                    )
                                }
                                "question" => match ask_question(
                                    inner,
                                    session,
                                    run,
                                    id,
                                    &prepared,
                                    cancel.child_token(),
                                )
                                .await?
                                {
                                    Some(value) => Ok(value),
                                    None => Err(ToolError::Interrupted),
                                },
                                "session_state" => Ok(inner.store.state(session).await?),
                                "todowrite" | "goal" => match crate::state::Mutation::parse(
                                    name,
                                    prepared.input().clone(),
                                ) {
                                    Ok(mutation) => match inner
                                        .store
                                        .update_state(session, &format!("{run}:{id}"), mutation)
                                        .await
                                    {
                                        Ok(value) => Ok(value),
                                        Err(Error::Conflict) => Err(ToolError::External(
                                            "Session state revision conflict; reload session_state"
                                                .into(),
                                        )),
                                        Err(error) => return Err(error),
                                    },
                                    Err(error) => Err(error),
                                },
                                "recall" => {
                                    match crate::recall::Query::parse(prepared.input().clone()) {
                                        Ok(query) => Ok(inner.store.recall(session, query).await?),
                                        Err(error) => Err(error),
                                    }
                                }
                                "start_job" => {
                                    start_background(inner, session, run, id, prepared).await
                                }
                                "job_status" => {
                                    match crate::jobs::Selector::parse(prepared.input().clone()) {
                                        Ok(selector) => Ok(inner
                                            .store
                                            .job(session, &selector.job_id)
                                            .await?
                                            .unwrap_or(
                                                json!({"error":"job not found in this Session"}),
                                            )),
                                        Err(error) => Err(error),
                                    }
                                }
                                "cancel_job" => {
                                    match crate::jobs::Selector::parse(prepared.input().clone()) {
                                        Ok(selector) => Ok(
                                            json!({"accepted":cancel_background(inner,session,&selector.job_id).await?}),
                                        ),
                                        Err(error) => Err(error),
                                    }
                                }
                                _ => {
                                    inner
                                        .tools
                                        .execute_prepared(
                                            prepared,
                                            &inner.policy,
                                            cancel.child_token(),
                                        )
                                        .await
                                }
                            };
                            match executed {
                                Ok(output) => {
                                    let is_error = (prepared_external && output["isError"] == true)
                                        || (name == "question" && output["state"] != "answered");
                                    (output, is_error)
                                }
                                Err(ToolError::Interrupted) => return Ok(()),
                                Err(error) => (json!({"error":error.to_string()}), true),
                            }
                        }
                    }
                };
                let signature = serde_json::to_string(
                    &json!({"name":name,"input":block["input"],"output":output,"is_error":is_error}),
                )?;
                inner
                    .store
                    .tool_result(session, run, id, output, is_error)
                    .await?;
                run_hooks(inner, session, crate::hooks::Event::ToolAfter, name).await?;
                let repeat = repeats.entry(signature).or_default();
                *repeat += 1;
                if *repeat >= 3 {
                    inner
                        .store
                        .record(
                            session,
                            "loop.detected",
                            json!({"run_id":run,"name":name,"repeats":repeat}),
                        )
                        .await?;
                    return Err(Error::Invalid(
                        "repeated identical tool input/result without new user input".into(),
                    ));
                }
            }
        }
        // Boundary reload always follows committed tool results. Steers promote
        // before continuation; queue only when this task would otherwise idle.
        if cancel.is_cancelled() {
            return Ok(());
        }
        let promoted = inner.store.promote(session, !reply.needs_tools).await?;
        if !reply.needs_tools && promoted.is_empty() {
            return Ok(());
        }
        if !promoted.is_empty() {
            allowance = 25;
            repeats.clear();
        }
        step += 1;
    }
}

async fn notify_admission(
    inner: &Inner,
    session: &str,
    admitted: &Admission,
    event: &str,
    data: Value,
) -> Result<(), Error> {
    if !admitted.pending || inner.stop.is_cancelled() {
        return Ok(());
    }
    let commands = inner
        .actors
        .lock()
        .await
        .get(session)
        .map(|actor| actor.commands.clone());
    let Some(commands) = commands else {
        inner.store.record(session, event, data).await?;
        return Ok(());
    };
    tokio::select! {biased;_=inner.stop.cancelled()=>{},result=commands.send(Command::Wake(false))=>{if result.is_err(){inner.store.record(session,event,data).await?;}}}
    Ok(())
}
async fn start_cron(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
) -> Result<Result<Value, ToolError>, Error> {
    let input = crate::cron::Input::parse(prepared.input().clone())
        .map_err(|_| Error::Invalid("invalid cron input".into()))?;
    let anchor = chrono::Local::now();
    let anchor_ms = anchor.timestamp_millis() as u64;
    let clock = tokio::time::Instant::now();
    let first = match crate::cron::next(input.cron.clone(), anchor).await {
        Ok(next) => next.timestamp_millis() as u64,
        Err(error) => return Ok(Err(ToolError::External(error.to_string()))),
    };
    let expires = anchor_ms.saturating_add(crate::cron::LIFETIME_MS);
    if first >= expires {
        return Ok(Err(ToolError::External(
            "cron has no occurrence within seven-day lifetime".into(),
        )));
    }
    let mut timers = inner.timers.lock().await;
    timers.retain(|_, timer| !timer.join.is_finished());
    let mut crons = inner.crons.lock().await;
    crons.retain(|_, cron| !cron.join.is_finished());
    if timers.len() + crons.len() >= 64
        || timers
            .values()
            .chain(crons.values())
            .filter(|timer| timer.session == session)
            .count()
            >= 8
    {
        return Ok(Err(ToolError::External(
            "schedule capacity exceeded".into(),
        )));
    }
    let pattern = input.cron.clone();
    let recurring = input.recurring;
    let data = inner
        .store
        .create_cron(
            session,
            run,
            call,
            inner.tools.location(),
            input,
            first..expires,
        )
        .await?;
    let id = data["cron_id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("cron id missing".into()))?
        .to_owned();
    if data["state"] != "scheduled" || crons.contains_key(&id) {
        return Ok(Ok(data));
    }
    let mut next = data["first_occurrence_ms"]
        .as_u64()
        .ok_or_else(|| Error::Invalid("cron occurrence missing".into()))?;
    let expires = data["expires_at_ms"]
        .as_u64()
        .ok_or_else(|| Error::Invalid("cron lifetime missing".into()))?;
    let cancel = inner.stop.child_token();
    let token = cancel.clone();
    let owner = inner.clone();
    let cron_id = id.clone();
    let source = session.to_owned();
    let join = tokio::spawn(async move {
        let result=async {
            loop {
                let deadline=clock+std::time::Duration::from_millis(next.saturating_sub(anchor_ms));
                let end=clock+std::time::Duration::from_millis(expires.saturating_sub(anchor_ms));
                tokio::select!{biased;_=token.cancelled()=>{owner.store.close_cron(&source,&cron_id,"cancelled").await?;return Ok::<_,Error>(());},_=tokio::time::sleep_until(end)=>{owner.store.close_cron(&source,&cron_id,"expired").await?;return Ok(());},_=tokio::time::sleep_until(deadline)=>{}}
                if token.is_cancelled(){owner.store.close_cron(&source,&cron_id,"cancelled").await?;return Ok(());}
                let logical_now=anchor_ms.saturating_add(clock.elapsed().as_millis().min(u64::MAX as u128) as u64);
                if logical_now>=expires{owner.store.close_cron(&source,&cron_id,"expired").await?;return Ok(());}
                if let Some(admitted)=owner.store.fire_cron(&source,&cron_id,next).await? {notify_admission(&owner,&source,&admitted,"cron.wake_failed",json!({"cron_id":cron_id,"input_id":admitted.input_id})).await?;}
                if !recurring{return Ok(());}
                // Advance from current logical time, not from the prior tick:
                // suspension never floods the inbox with a catch-up burst.
                let advance_after=anchor_ms.saturating_add(clock.elapsed().as_millis().min(u64::MAX as u128) as u64);
                let after=chrono::Local.timestamp_millis_opt(advance_after as i64).single().ok_or_else(||Error::Invalid("cron clock out of range".into()))?;
                next=crate::cron::next(pattern.clone(),after).await?.timestamp_millis() as u64;
                owner.store.record(&source,"cron.next",json!({"cron_id":cron_id,"next_occurrence_ms":next,"advanced_after_ms":advance_after})).await?;
            }
        }.await;
        if let Err(error) = result {
            let _ = owner.store.close_cron(&source, &cron_id, "failed").await;
            let _ = owner
                .store
                .record(
                    &source,
                    "cron.failed",
                    json!({"cron_id":cron_id,"message":error.to_string()}),
                )
                .await;
        }
    });
    crons.insert(
        id,
        Background {
            session: session.into(),
            cancel,
            join,
        },
    );
    Ok(Ok(data))
}
async fn cancel_cron(inner: &Inner, session: &str, id: &str) -> Result<bool, Error> {
    let token = inner
        .crons
        .lock()
        .await
        .get(id)
        .filter(|cron| cron.session == session)
        .map(|cron| cron.cancel.clone());
    let Some(token) = token else {
        return Ok(false);
    };
    let accepted = inner.store.close_cron(session, id, "cancelled").await?;
    if accepted {
        token.cancel();
    }
    Ok(accepted)
}

async fn start_wakeup(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
) -> Result<Result<Value, ToolError>, Error> {
    let input = crate::wakeup::Input::parse(prepared.input().clone())
        .map_err(|_| Error::Invalid("invalid wakeup input".into()))?;
    let mut timers = inner.timers.lock().await;
    timers.retain(|_, timer| !timer.join.is_finished());
    let mut crons = inner.crons.lock().await;
    crons.retain(|_, cron| !cron.join.is_finished());
    if timers.len() + crons.len() >= 64
        || timers
            .values()
            .chain(crons.values())
            .filter(|timer| timer.session == session)
            .count()
            >= 8
    {
        return Ok(Err(ToolError::External("wakeup capacity exceeded".into())));
    }
    drop(crons);
    let data = inner
        .store
        .create_wakeup(session, run, call, inner.tools.location(), input)
        .await?;
    let id = data["timer_id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("timer id missing".into()))?
        .to_owned();
    if data["state"] != "scheduled" || timers.contains_key(&id) {
        return Ok(Ok(data));
    }
    let delay = data["due_at_ms"]
        .as_u64()
        .unwrap_or(now_ms())
        .saturating_sub(now_ms());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(delay);
    let cancel = inner.stop.child_token();
    let token = cancel.clone();
    let owner = inner.clone();
    let timer_id = id.clone();
    let source = session.to_owned();
    let join = tokio::spawn(async move {
        let result=async {
            tokio::select!{biased;_=token.cancelled()=>{owner.store.close_wakeup(&source,&timer_id,"cancelled").await?;return Ok::<_,Error>(());},_=tokio::time::sleep_until(deadline)=>{}}
            if token.is_cancelled(){owner.store.close_wakeup(&source,&timer_id,"cancelled").await?;return Ok(());}
            if let Some(admitted)=owner.store.fire_wakeup(&source,&timer_id).await? {
                notify_admission(&owner,&source,&admitted,"wakeup.wake_failed",json!({"timer_id":timer_id,"input_id":admitted.input_id})).await?;
            }
            Ok(())
        }.await;
        if let Err(error) = result {
            let _ = owner.store.close_wakeup(&source, &timer_id, "failed").await;
            let _ = owner
                .store
                .record(
                    &source,
                    "wakeup.failed",
                    json!({"timer_id":timer_id,"message":error.to_string()}),
                )
                .await;
        }
    });
    timers.insert(
        id,
        Background {
            session: session.into(),
            cancel,
            join,
        },
    );
    Ok(Ok(data))
}
async fn cancel_wakeup(inner: &Inner, session: &str, id: &str) -> Result<bool, Error> {
    let token = inner
        .timers
        .lock()
        .await
        .get(id)
        .filter(|timer| timer.session == session)
        .map(|timer| timer.cancel.clone());
    let Some(token) = token else {
        return Ok(false);
    };
    let accepted = inner.store.close_wakeup(session, id, "cancelled").await?;
    if accepted {
        token.cancel();
    }
    Ok(accepted)
}

async fn ask_question(
    inner: &Inner,
    session: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
    cancel: CancellationToken,
) -> Result<Option<Value>, Error> {
    let input = crate::question::Input::parse(prepared.input().clone())
        .map_err(|_| Error::Invalid("invalid question input".into()))?;
    let timeout = input.timeout_ms;
    let request = inner
        .store
        .request_question(session, run, call, inner.tools.location(), input)
        .await?;
    let id = request["question_id"]
        .as_str()
        .ok_or_else(|| Error::Invalid("question id missing".into()))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout);
    loop {
        if cancel.is_cancelled() {
            return Ok(None);
        }
        if let Some(resolved) = inner.store.question_resolution(session, id).await? {
            return Ok(Some(resolved));
        }
        if tokio::time::Instant::now() >= deadline
            || now_ms() >= request["expires_at_ms"].as_u64().unwrap_or(0)
        {
            inner.store.expire_question(session, id).await?;
            continue;
        }
        tokio::select! {_=cancel.cancelled()=>return Ok(None),_=tokio::time::sleep(std::time::Duration::from_millis(25))=>{}}
    }
}

async fn run_hooks(
    inner: &Inner,
    session: &str,
    phase: crate::hooks::Event,
    tool: &str,
) -> Result<Option<String>, Error> {
    let hooks = inner.tools.hooks();
    if hooks.is_empty() {
        return Ok(None);
    }
    let mut blocked = None;
    for hook in hooks
        .iter()
        .filter(|hook| hook.event == phase && hook.matches(tool))
    {
        let started = std::time::Instant::now();
        let result = inner
            .tools
            .run_hook(hook, tokio_util::sync::CancellationToken::new())
            .await;
        let (outcome, exit_code, reason) = match &result {
            Ok(output) => {
                let exit = output["exit_code"].as_i64();
                let reason = output["reason"].as_str().unwrap_or("completed");
                let outcome = if exit == Some(0) && reason == "completed" {
                    "ok"
                } else {
                    "failed"
                };
                (outcome, exit, reason)
            }
            Err(_) => ("error", None, "error"),
        };
        inner
            .store
            .record(
                session,
                "hook.completed",
                json!({
                    "phase": phase.name(),
                    "tool": tool,
                    "outcome": outcome,
                    "exit_code": exit_code,
                    "reason": reason,
                    "duration_ms": started.elapsed().as_millis() as u64,
                }),
            )
            .await?;
        if phase == crate::hooks::Event::ToolBefore && outcome != "ok" && blocked.is_none() {
            blocked = Some(format!("blocked by tool_before hook (outcome {outcome})"));
        }
    }
    Ok(blocked)
}

async fn authorize(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
    cancel: CancellationToken,
) -> Result<bool, Error> {
    match inner
        .policy
        .evaluate(prepared.name(), prepared.resource(), prepared.access())
    {
        Decision::Allow => return Ok(true),
        Decision::Deny => {
            inner.store.record(session,"permission.denied",json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"policy_revision":inner.policy.revision()})).await?;
            return Ok(false);
        }
        Decision::Ask => {}
    }
    let approval = Approval {
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: session.into(),
        run_id: run.into(),
        call_id: call.into(),
        location: inner.tools.location().into(),
        tool: prepared.name().into(),
        resource: prepared.resource().into(),
        input: prepared.input().clone(),
        input_hash: input_digest(
            inner.tools.location(),
            prepared.name(),
            prepared.resource(),
            prepared.input(),
        )?,
        policy_revision: inner.policy.revision().into(),
        expires_at_ms: now_ms().saturating_add(inner.policy.timeout_ms()),
    };
    inner.store.request_approval(approval.clone()).await?;
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(inner.policy.timeout_ms());
    loop {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        match inner
            .store
            .approval_state(&approval.request_id)
            .await?
            .as_str()
        {
            "allow" => return Ok(true),
            "pending" => {}
            _ => return Ok(false),
        }
        if tokio::time::Instant::now() >= deadline || now_ms() >= approval.expires_at_ms {
            let expired = inner
                .store
                .resolve_approval(
                    session,
                    Response {
                        request_id: approval.request_id.clone(),
                        input_hash: approval.input_hash.clone(),
                        policy_revision: approval.policy_revision.clone(),
                        decision: Decision::Deny,
                    },
                )
                .await;
            match expired {
                Ok(_) | Err(Error::ApprovalExpired | Error::ApprovalResolved) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        tokio::select! {_=cancel.cancelled()=>return Ok(false),_=tokio::time::sleep(std::time::Duration::from_millis(25))=>{}}
    }
}

async fn cancel_background(inner: &Inner, session: &str, id: &str) -> Result<bool, Error> {
    let token = {
        let jobs = inner.jobs.lock().await;
        match jobs.get(id) {
            Some(job) => {
                if job.session != session {
                    return Err(Error::Invalid("job belongs to another Session".into()));
                }
                Some(job.cancel.clone())
            }
            None => None,
        }
    };
    let Some(token) = token else {
        return Ok(false);
    };
    if inner
        .store
        .job(session, id)
        .await?
        .is_none_or(|job| !matches!(job["state"].as_str(), Some("queued" | "running")))
    {
        return Ok(false);
    }
    token.cancel();
    Ok(true)
}

async fn start_background(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: Prepared,
) -> Result<Value, ToolError> {
    if inner.stop.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let mut jobs = inner.jobs.lock().await;
    if jobs.len() >= 32 {
        return Err(ToolError::InvalidInput);
    }
    let admission = inner
        .store
        .create_job(session, run, call, prepared.input().clone())
        .await
        .map_err(|error| ToolError::Io(std::io::Error::other(error.to_string())))?;
    if admission["duplicate"] == true {
        return Ok(admission);
    }
    let id = admission["job_id"]
        .as_str()
        .ok_or(ToolError::InvalidInput)?
        .to_owned();
    let token = inner.stop.child_token();
    let task_token = token.clone();
    let owner = session.to_owned();
    let task_owner = owner.clone();
    let task_id = id.clone();
    let task_inner = inner.clone();
    let join = tokio::spawn(async move {
        let work_inner = task_inner.clone();
        let work_owner = task_owner.clone();
        let work_id = task_id.clone();
        let work = tokio::spawn(async move {
            background(work_inner, &work_owner, &work_id, prepared, task_token).await
        });
        let result = match work.await {
            Ok(result) => result,
            Err(_) => task_inner
                .store
                .finish_job(
                    &task_owner,
                    &task_id,
                    "unknown",
                    json!({"error":"job execution task panicked"}),
                )
                .await
                .map(|_| ()),
        };
        if let Err(error) = result {
            let _=task_inner.progress.send(json!({"session_id":task_owner,"kind":"job.error","job_id":task_id,"message":error.to_string()}));
        }
        task_inner.jobs.lock().await.remove(&task_id);
    });
    jobs.insert(
        id,
        Background {
            session: owner,
            cancel: token,
            join,
        },
    );
    Ok(admission)
}

async fn background(
    inner: Arc<Inner>,
    session: &str,
    id: &str,
    prepared: Prepared,
    cancel: CancellationToken,
) -> Result<(), Error> {
    let permit = tokio::select! {_=cancel.cancelled()=>None,slot=inner.job_slots.clone().acquire_owned()=>Some(slot.map_err(|_|Error::Closed)?)};
    let Some(_permit) = permit else {
        inner
            .store
            .finish_job(
                session,
                id,
                "cancelled",
                json!({"reason":"cancelled_before_dispatch"}),
            )
            .await?;
        return Ok(());
    };
    inner.store.start_job(session, id).await?;
    let result = inner
        .tools
        .execute_background(prepared, cancel.clone())
        .await;
    let (state, output) = match result {
        Ok(output) => {
            let state = if output["reason"] == "cancelled" {
                "cancelled"
            } else if output["reason"] == "completed" && output["exit_code"] == 0 {
                "completed"
            } else {
                "failed"
            };
            (state, output)
        }
        Err(ToolError::Interrupted) => ("cancelled", json!({"reason":"cancelled_before_dispatch"})),
        Err(error) => ("failed", json!({"error":error.to_string()})),
    };
    inner.store.finish_job(session, id, state, output).await?;
    Ok(())
}
