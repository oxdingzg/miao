mod command;
mod shell;
use crate::{
    approval::{now_ms, Approval, Response},
    context_trigger::{self, ContextLimits},
    permission::{input_digest, Config, Decision, Policy},
    protocol::{Admission, Attachment, Delivery, Error, Input, ModelRequest},
    provider::{Provider, ProviderError},
    store::{RuntimeLease, SessionLease, Store},
    tool_replay::ToolReplay,
    tools::{Prepared, ToolError, Tools},
};
use chrono::TimeZone;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::io::AsyncBufReadExt;
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
    tool_replay: Option<ToolReplay>,
    actors: Mutex<HashMap<String, Actor>>,
    jobs: Mutex<HashMap<String, Background>>,
    terminals: crate::terminal::Registry,
    timers: Mutex<HashMap<String, Background>>,
    crons: Mutex<HashMap<String, Background>>,
    job_slots: Arc<Semaphore>,
    slots: Arc<Semaphore>,
    subagent_slots: Arc<Semaphore>,
    started: Mutex<std::collections::HashSet<String>>,
    /// Sessions with a drain in this process. The timer heartbeat must not claim
    /// one: claiming advances the epoch and would fence the active drain.
    draining: std::sync::Mutex<std::collections::HashSet<String>>,
    stop: CancellationToken,
    heartbeat: Mutex<Option<JoinHandle<()>>>,
    progress: broadcast::Sender<Value>,
    product: Arc<std::sync::RwLock<crate::product::State>>,
    context: Mutex<Option<ContextLimits>>,
    roles: Mutex<crate::roles::Bindings>,
    route_limits: Mutex<crate::model_routes::RouteLimits>,
    /// Task-specific verification command run before a run may finish.
    verification: Mutex<Option<String>>,
    breaker: Mutex<context_trigger::Breaker>,
    /// Sessions whose next provider request carries the post-compaction
    /// restore budget note. Process-local and request-scoped, like the host
    /// runner's `turns` map.
    restore_pending: Mutex<std::collections::HashSet<String>>,
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
    Shell(crate::session_shell::Invocation),
    Wake(bool),
    Cancel(oneshot::Sender<bool>),
    CancelIf(String, oneshot::Sender<Result<bool, Error>>),
    Approve(Response, bool, oneshot::Sender<Result<(), Error>>),
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
        Self::with_policy_and_tool_replay(store, provider, tools, policy, None).await
    }

    pub async fn with_policy_and_tool_replay(
        store: Store,
        provider: Arc<dyn Provider>,
        tools: Tools,
        policy: Policy,
        tool_replay: Option<ToolReplay>,
    ) -> Result<Self, Error> {
        if tool_replay.is_some() && !tools.hooks().is_empty() {
            return Err(Error::Invalid(
                "native tool replay does not execute configured hooks".into(),
            ));
        }
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
            .enable_web(policy.web_enabled())
            .map_err(|error| Error::Invalid(error.to_string()))?
            .with_cron(policy.cron_enabled())
            .with_wakeup(policy.wakeup_enabled())
            .with_writes(policy.writes_enabled())
            .with_process(policy.process_enabled(), policy.process_network())
            .with_background(policy.background_enabled())
            .with_delegation(policy.subagents_enabled())
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
        store.recover_jobs_unowned().await?;
        store.recover_questions_unowned().await?;
        store.adopt_wakeups().await?;
        store.adopt_crons().await?;
        let (progress, _) = broadcast::channel(256);
        let runtime = Self {
            inner: Arc::new(Inner {
                id: uuid::Uuid::new_v4().to_string(),
                _lease: lease,
                policy,
                store,
                provider,
                tools,
                tool_replay,
                actors: Mutex::new(HashMap::new()),
                jobs: Mutex::new(HashMap::new()),
                terminals: crate::terminal::Registry::default(),
                timers: Mutex::new(HashMap::new()),
                crons: Mutex::new(HashMap::new()),
                job_slots: Arc::new(Semaphore::new(2)),
                slots: Arc::new(Semaphore::new(8)),
                subagent_slots: Arc::new(Semaphore::new(crate::subagent::CONCURRENCY_LIMIT)),
                started: Mutex::new(std::collections::HashSet::new()),
                draining: std::sync::Mutex::new(std::collections::HashSet::new()),
                stop: CancellationToken::new(),
                heartbeat: Mutex::new(None),
                progress,
                product: Arc::new(std::sync::RwLock::new(crate::product::State::default())),
                context: Mutex::new(None),
                roles: Mutex::new(crate::roles::Bindings::default()),
                route_limits: Mutex::new(crate::model_routes::RouteLimits::default()),
                verification: Mutex::new(None),
                breaker: Mutex::new(crate::context_trigger::Breaker::new(3)),
                restore_pending: Mutex::new(std::collections::HashSet::new()),
            }),
        };
        let inner = runtime.inner.clone();
        for (session, timer_id, due_at_ms) in inner.store.adopt_wakeups().await? {
            let background = arm_wakeup(&inner, session.clone(), timer_id.clone(), due_at_ms);
            inner.timers.lock().await.insert(timer_id, background);
        }
        for (session, cron_id, pattern, recurring, next, expires) in
            inner.store.adopt_crons().await?
        {
            let background = spawn_cron_task(
                &inner,
                session.clone(),
                cron_id.clone(),
                pattern,
                recurring,
                next,
                expires,
            );
            inner.crons.lock().await.insert(cron_id, background);
        }
        // Timer ownership heartbeat: while this runtime is alive it owns the
        // armed timers; the ticker lets a supervisor distinguish live engines
        // from dead ones before adopting their sessions.
        let heartbeat_inner = runtime.inner.clone();
        let heartbeat_stop = runtime.inner.stop.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = heartbeat_stop.cancelled() => return,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
                }
                let sessions: Vec<String> = {
                    let timers = heartbeat_inner.timers.lock().await;
                    let crons = heartbeat_inner.crons.lock().await;
                    timers
                        .values()
                        .chain(crons.values())
                        .map(|background| background.session.clone())
                        .collect::<std::collections::HashSet<_>>()
                        .into_iter()
                        .collect()
                };
                for session in sessions {
                    // A draining Session renews its own claim; a heartbeat here
                    // would advance the epoch and fence the active owner. Check
                    // the durable lease, not just this process's drains, because
                    // the owner may be another window.
                    if heartbeat_inner
                        .store
                        .lease_alive(&session)
                        .await
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    if heartbeat_inner
                        .draining
                        .lock()
                        .map(|draining| draining.contains(&session))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    if heartbeat_inner
                        .store
                        .active_run(&session)
                        .await
                        .ok()
                        .flatten()
                        .is_some()
                    {
                        continue;
                    }
                    let _ = heartbeat_inner
                        .store
                        .heartbeat_lease(&session, 30_000)
                        .await;
                }
            }
        });
        *runtime.inner.heartbeat.lock().await = Some(heartbeat);
        Ok(runtime)
    }

    /// Register host-provided product tools and the reverse bridge used to
    /// execute them, plus the plugin hook marker naming the families the host
    /// resolves in-process. Call once at startup, before any run.
    pub fn with_product_tools(
        &self,
        tools: Vec<crate::protocol::ToolDefinition>,
        bridge: crate::product::Bridge,
        plugin_hooks: Option<crate::product::Marker>,
    ) {
        self.inner.tools.with_product_tools(tools.clone());
        let mut state = self.inner.product.write().unwrap();
        state.tools = tools;
        state.bridge = Some(bridge);
        state.marker = plugin_hooks;
    }

    /// Route a host reply for a product-tool bridge call.
    pub fn deliver_product_reply(&self, bridge_id: u64, value: Value) -> bool {
        match self
            .inner
            .product
            .read()
            .unwrap()
            .bridge
            .as_ref()
            .map(|bridge| bridge.pending())
        {
            Some(pending) => crate::product::deliver(pending, bridge_id, value),
            None => false,
        }
    }

    pub fn controller(&self) -> Controller {
        Controller {
            runtime_id: self.inner.id.clone(),
        }
    }

    /// Configure automatic context management (roadmap §2.13). `None` keeps it
    /// off; without limits the run loop never attempts a checkpoint.
    /// Require this command to pass before a run may finish; see the
    /// completion check in the turn loop.
    pub async fn verify_with(&self, command: Option<String>) {
        *self.inner.verification.lock().await = command;
    }

    pub async fn set_context_limits(&self, limits: Option<ContextLimits>) {
        *self.inner.context.lock().await = limits;
    }

    /// Purpose-role model bindings (ADR-14): a binding is a model id on the
    /// Session's own provider. Unbound roles — and roles the provider
    /// rejects — run on the primary model.
    pub async fn set_role_bindings(&self, roles: crate::roles::Bindings) {
        *self.inner.roles.lock().await = roles;
    }

    /// Per-model capacity from the host route manifest, consulted before a
    /// role-bound request is attempted.
    pub async fn set_route_limits(&self, limits: crate::model_routes::RouteLimits) {
        *self.inner.route_limits.lock().await = limits;
    }

    /// An explicit operator `compact` is the automatic trigger's breaker reset:
    /// it clears the failure streak so a repaired summarizer gets a fresh try
    /// instead of staying off until the process restarts.
    pub async fn reset_compaction_breaker(&self) {
        self.inner.breaker.lock().await.reset();
    }

    /// Record a host-resolved agent for this Session's subsequent turns.
    ///
    /// A tool name the registry does not know is refused here rather than
    /// silently ignored: a host that typos an agent's tool list must hear about
    /// it, and `allow`/`deny` only ever narrow the registered surface.
    pub async fn set_agent(
        &self,
        session: &str,
        agent: crate::session_agent::AgentManifest,
    ) -> Result<Value, Error> {
        validate_agent(&self.inner, &agent)?;
        let binding = self
            .inner
            .store
            .model_selection(session)
            .await?
            .or_else(|| agent.model.clone());
        let binding = match self.inner.store.account_selection(session).await? {
            Some(account) => crate::session_account::resolve(
                &self.inner.provider,
                binding.as_ref(),
                account.credential_id.as_deref(),
            )?,
            None => binding,
        };
        let provider = crate::session_model::select(&self.inner.provider, binding.as_ref())?;
        if let Some(request) = &agent.request {
            provider
                .with_request_options(request.clone())
                .map_err(|error| Error::Invalid(error.to_string()))?;
        }
        crate::session_model::validate_history(
            &self.inner.store.selected_history(session).await?,
            binding.as_ref(),
            provider.identity(),
        )?;
        self.inner.store.set_agent(session, agent).await
    }

    /// Record an operator request to compact this Session at its next settled
    /// assistant boundary, then wake it. A continuable drain honours the request
    /// at that boundary even when the budget gate is under its threshold; an idle
    /// Session with no inbox row has nothing to drain, so the request stays
    /// durable until its next provider turn.
    pub async fn request_compact(&self, session: &str) -> Result<Value, Error> {
        let result = self.inner.store.request_compaction(session).await?;
        let _ = self.wake(session, false).await;
        Ok(result)
    }

    pub async fn approve(
        &self,
        controller: &Controller,
        session: &str,
        response: Response,
    ) -> Result<(), Error> {
        self.approve_inner(controller, session, response, false)
            .await
    }

    pub async fn approve_persistent(
        &self,
        controller: &Controller,
        session: &str,
        response: Response,
    ) -> Result<(), Error> {
        self.approve_inner(controller, session, response, true)
            .await
    }

    async fn approve_inner(
        &self,
        controller: &Controller,
        session: &str,
        response: Response,
        persistent: bool,
    ) -> Result<(), Error> {
        let agent = self.inner.store.agent(session).await?;
        let policy = self
            .inner
            .policy
            .for_agent(agent.as_ref().map(|(manifest, _)| manifest))?;
        if controller.runtime_id != self.inner.id || response.policy_revision != policy.revision() {
            return Err(Error::ApprovalMismatch);
        }
        let commands = {
            let actors = self.inner.actors.lock().await;
            actors.get(session).map(|a| a.commands.clone())
        };
        let commands = commands.ok_or(Error::ApprovalResolved)?;
        let (send, receive) = oneshot::channel();
        commands
            .send(Command::Approve(response, persistent, send))
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

    pub async fn reject_question(
        &self,
        controller: &Controller,
        session: &str,
        rejection: crate::question::Rejection,
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
        self.inner.store.reject_question(session, rejection).await
    }

    pub async fn initialize(&self, session: &str, title: &str) -> Result<Value, Error> {
        self.inner
            .store
            .initialize(session, title, self.inner.tools.location())
            .await
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    pub(crate) fn validate_transfer_preparation(
        &self,
        preparation: &crate::transfer_activation::Preparation,
    ) -> Result<(), Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if preparation.directory.canonicalize()?
            != std::path::Path::new(self.inner.tools.location()).canonicalize()?
        {
            return Err(Error::Conflict);
        }
        let provider =
            crate::session_model::select(&self.inner.provider, Some(&preparation.binding))?;
        if provider.identity() != Some(preparation.identity.clone()) {
            return Err(Error::Conflict);
        }
        if let Some(account) = &preparation.account {
            let binding = crate::session_account::resolve(
                &self.inner.provider,
                Some(&preparation.binding),
                account.credential_id.as_deref(),
            )?;
            if binding.as_ref() != Some(&preparation.binding) {
                return Err(Error::Conflict);
            }
        }
        crate::session_model::validate_history(
            &preparation
                .messages
                .iter()
                .map(|message| message.message.clone())
                .collect::<Vec<_>>(),
            Some(&preparation.binding),
            provider.identity(),
        )?;
        Ok(())
    }

    pub async fn activate_transfer(
        &self,
        id: &str,
        digest: &str,
        product_database: &std::path::Path,
    ) -> Result<Value, Error> {
        let preparation = self
            .inner
            .store
            .session_transfer_preparation(id)
            .await?
            .ok_or(Error::Conflict)?;
        let preparation = serde_json::from_value(preparation)?;
        self.validate_transfer_preparation(&preparation)?;
        self.inner
            .store
            .activate_session_transfer(id, digest, product_database)
            .await
    }

    /// Detaching the last UI must not kill useful background work.
    pub async fn has_live_work(&self) -> Result<bool, Error> {
        if !self.inner.jobs.lock().await.is_empty()
            || !self.inner.timers.lock().await.is_empty()
            || !self.inner.crons.lock().await.is_empty()
        {
            return Ok(true);
        }
        self.inner.store.has_running_runs().await
    }

    /// Ephemeral deltas have no durable cursor. Slow clients lose deltas and
    /// resynchronize from committed messages, never block provider execution.
    pub fn progress(&self) -> broadcast::Receiver<Value> {
        self.inner.progress.subscribe()
    }

    pub async fn admit(&self, input: Input, resume: bool) -> Result<Admission, Error> {
        self.admit_with(input, Vec::new(), resume).await
    }

    /// Admit a prompt with inline media attachments. The attachments are part of
    /// the durable admission identity and are promoted into the user message at
    /// the next safe boundary.
    pub async fn admit_with(
        &self,
        input: Input,
        attachments: Vec<Attachment>,
        resume: bool,
    ) -> Result<Admission, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        // An active migration transition freezes the Session: neither engine
        // may admit work until the transfer reaches a terminal state.
        if self.inner.store.migration_active(&input.session_id).await? {
            return Err(Error::Conflict);
        }
        for agent in &input.agent_references.catalog {
            validate_agent(&self.inner, agent)?;
        }
        if let Some(command) = &input.command {
            command.validate()?;
            if let Some(authority) = &command.authority {
                if authority.default_agent.as_ref().is_some_and(|name| {
                    !input
                        .agent_references
                        .catalog
                        .iter()
                        .any(|agent| &agent.name == name)
                }) {
                    return Err(Error::Invalid(
                        "default command agent is not in the captured host catalog".into(),
                    ));
                }

                if let Some(agent) = &authority.agent {
                    validate_agent(&self.inner, agent)?;
                }
                if let Some(model) = &authority.model {
                    crate::session_model::select(&self.inner.provider, Some(model))?;
                }
            }
        }
        let session = input.session_id.clone();
        let admission = self
            .inner
            .store
            .admit_attachments_at(
                input,
                attachments,
                Some(self.inner.tools.location().to_owned()),
            )
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

    /// Set the Session collaboration mode. Recorded durably and read at each
    /// provider boundary; Plan denies writes, execution and background work.
    pub async fn set_mode(
        &self,
        session: &str,
        mode: crate::protocol::CollaborationMode,
    ) -> Result<(), Error> {
        self.inner.store.set_mode(session, mode).await?;
        Ok(())
    }

    pub async fn shell(
        &self,
        session: &str,
        invocation: crate::session_shell::Invocation,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        let receipt = self
            .inner
            .store
            .admit_shell(session, invocation.clone())
            .await?;
        if receipt["state"] == "pending" {
            let commands = self.actor(session).await?;
            commands
                .send(Command::Shell(invocation))
                .await
                .map_err(|_| Error::Closed)?;
        }
        Ok(receipt)
    }

    pub async fn shell_status(&self, session: &str, call: &str) -> Result<Value, Error> {
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        self.inner.store.shell_status(session, call).await
    }

    pub async fn wake_pending(&self, session: &str) -> Result<(), Error> {
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        self.wake(session, false).await
    }

    pub async fn resume(&self, session: &str) -> Result<(), Error> {
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        if self.inner.store.migration_active(session).await? {
            return Err(Error::Conflict);
        }
        self.wake(session, true).await
    }

    pub fn model_catalog(&self) -> Vec<crate::model_catalog::Info> {
        self.inner.provider.model_catalog()
    }

    pub async fn inject(
        &self,
        session: &str,
        input_id: Option<String>,
        text: &str,
        source: &str,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        self.inner
            .store
            .inject(
                session,
                &input_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                text,
                source,
            )
            .await
    }

    pub async fn select_account(
        &self,
        session: &str,
        credential_id: Option<String>,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        if credential_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err(Error::Invalid("invalid credential identity".into()));
        }
        let current = match self.inner.store.model_selection(session).await? {
            Some(binding) => Some(binding),
            None => self
                .inner
                .store
                .agent(session)
                .await?
                .and_then(|(agent, _)| agent.model),
        };
        let binding = crate::session_account::resolve(
            &self.inner.provider,
            current.as_ref(),
            credential_id.as_deref(),
        )?;
        let provider = crate::session_model::select(&self.inner.provider, binding.as_ref())?;
        let (history, _) = self.inner.store.selected_input(session).await?;
        crate::session_model::validate_history(&history, binding.as_ref(), provider.identity())?;
        self.inner
            .store
            .select_account_binding(session, binding, credential_id)
            .await
    }

    pub async fn select_model(
        &self,
        session: &str,
        binding: Option<crate::session_model::Binding>,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        let explicit = binding
            .as_ref()
            .and_then(|binding| binding.route_id.as_ref())
            .and_then(|route| self.inner.provider.route_account(route))
            .filter(|account| !account.is_default);
        let account = match &explicit {
            Some(account) => account
                .id
                .as_ref()
                .map(|id| crate::session_account::Selection {
                    credential_id: Some(id.clone()),
                }),
            None => self.inner.store.account_selection(session).await?,
        };
        let effective = if explicit.is_some() {
            binding.clone()
        } else {
            match &account {
                Some(account) => crate::session_account::resolve(
                    &self.inner.provider,
                    binding.as_ref(),
                    account.credential_id.as_deref(),
                )?,
                None => binding.clone(),
            }
        };
        let selected = crate::session_model::select(&self.inner.provider, effective.as_ref())?;
        let (history, _) = self.inner.store.selected_input(session).await?;
        crate::session_model::validate_history(&history, effective.as_ref(), selected.identity())?;
        if explicit.is_some() {
            self.inner
                .store
                .select_model_with_account(session, binding, account)
                .await
        } else {
            self.inner.store.select_model(session, binding).await
        }
    }

    pub async fn resolve_recovery(
        &self,
        session: &str,
        call: &str,
        operation: &str,
        decision: crate::recovery::Decision,
        resume: bool,
    ) -> Result<Value, Error> {
        if self.inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if self.inner.store.location(session).await?.as_deref() != Some(self.inner.tools.location())
        {
            return Err(Error::Conflict);
        }
        let result = self
            .inner
            .store
            .resolve_recovery(session, call, operation, decision)
            .await?;
        // An exact retry after promotion must not force a second provider
        // continuation. Advisory wake only drains still-pending durable input.
        if resume {
            self.wake(session, false).await?;
        }
        Ok(result)
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

    /// Detach a Session's actor (ACP `session/close`): cancel any running
    /// drain, remove the attachment, and await the coordinator so the bounded
    /// attachment table frees immediately. Unattached sessions report false.
    pub async fn detach(&self, session: &str) -> Result<bool, Error> {
        let _ = self.cancel(session).await?;
        let actor = {
            let mut actors = self.inner.actors.lock().await;
            actors.remove(session)
        };
        let Some(actor) = actor else {
            return Ok(false);
        };
        drop(actor.commands);
        let _ = actor.join.await;
        Ok(true)
    }

    /// Delete a Session and everything it owns.
    ///
    /// A running drain is interrupted and awaited first, then every in-process
    /// task the Session owns is stopped, and only then are its durable rows
    /// deleted. Stopping the tasks is not cosmetic: an armed cron or wakeup
    /// re-admits through `admit_input`, which re-creates the Session row, so a
    /// surviving task would resurrect the identity just removed.
    pub async fn remove(&self, session: &str) -> Result<Value, Error> {
        let _ = self.detach(session).await?;
        stop_session(&self.inner, session).await;
        self.inner.store.remove_session(session).await
    }

    pub async fn cancel(&self, session: &str) -> Result<bool, Error> {
        let commands = {
            let actors = self.inner.actors.lock().await;
            actors.get(session).map(|a| a.commands.clone())
        };
        let Some(commands) = commands else {
            // No local drain: the Session is owned by another runtime, so ask
            // its owner through the durable journal.
            let Some(run) = self.inner.store.active_run(session).await? else {
                return Ok(false);
            };
            self.inner
                .store
                .request_cancel(session, &run, "operator")
                .await?;
            return Ok(true);
        };
        let (reply, result) = oneshot::channel();
        commands
            .send(Command::Cancel(reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)
    }

    /// Check and cancel inside the owning actor. A stale UI execution ID must
    /// never cancel a new run admitted after the caller observed the old one.
    pub async fn cancel_if(&self, session: &str, run: &str) -> Result<bool, Error> {
        let commands = {
            let actors = self.inner.actors.lock().await;
            actors.get(session).map(|actor| actor.commands.clone())
        };
        let Some(commands) = commands else {
            if self.inner.store.active_run(session).await?.as_deref() != Some(run) {
                return Ok(false);
            }
            self.inner
                .store
                .request_cancel(session, run, "operator")
                .await?;
            return Ok(true);
        };
        let (reply, result) = oneshot::channel();
        commands
            .send(Command::CancelIf(run.to_owned(), reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)?
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
        if let Some(heartbeat) = self.inner.heartbeat.lock().await.take() {
            let _ = heartbeat.await;
        }
        self.inner.terminals.shutdown().await;
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

async fn refuse_shell_queue(
    inner: &Inner,
    session: &str,
    shells: &mut std::collections::VecDeque<crate::session_shell::Invocation>,
) {
    for invocation in std::mem::take(shells) {
        if let Err(error) = inner
            .store
            .refuse_pending_shell(session, &invocation.call_id)
            .await
        {
            let _=inner.progress.send(json!({"session_id":session,"kind":"runtime.error","code":error.code(),"message":error.to_string()}));
        }
    }
}

async fn coordinate(session: String, inner: Arc<Inner>, mut commands: mpsc::Receiver<Command>) {
    let mut tasks = JoinSet::new();
    let mut active: Option<CancellationToken> = None;
    let mut wake = None;
    let mut shells = std::collections::VecDeque::<crate::session_shell::Invocation>::new();
    let mut active_shell = None;
    loop {
        if active.is_none() {
            if let Some(invocation) = shells.pop_front() {
                let cancel = inner.stop.child_token();
                active = Some(cancel.clone());
                active_shell = Some(invocation.call_id.clone());
                tasks.spawn(shell::execute(
                    session.clone(),
                    inner.clone(),
                    invocation,
                    cancel,
                ));
            } else if let Some(force) = wake.take() {
                let cancel = inner.stop.child_token();
                active = Some(cancel.clone());
                let (session, inner) = (session.clone(), inner.clone());
                tasks.spawn(boxed_drain(session, inner, force, cancel));
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
                Some(Command::Shell(invocation)) => {
                    if active_shell.as_deref()!=Some(&invocation.call_id) && !shells.iter().any(|item|item.call_id==invocation.call_id) {shells.push_back(invocation);}
                },
                Some(Command::Wake(force)) => wake=Some(wake.unwrap_or(false)||(force && active.is_none())),
                Some(Command::Cancel(reply)) => {
                    wake=None;
                    refuse_shell_queue(&inner,&session,&mut shells).await;
                    if let Some(cancel)=&active { cancel.cancel(); }
                    let _=reply.send(active.is_some());
                }
                Some(Command::CancelIf(expected,reply)) => {
                    // The actor cannot start another drain during this check:
                    // the active token and durable run belong to the same owner.
                    let result = match inner.store.active_run(&session).await {
                        Ok(Some(run)) if run == expected && active.as_ref().is_some_and(|token| !token.is_cancelled()) => {
                            wake = None;
                            refuse_shell_queue(&inner,&session,&mut shells).await;
                            if let Some(token) = &active { token.cancel(); }
                            Ok(true)
                        }
                        Ok(_) => Ok(false),
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(result);
                },
                Some(Command::Approve(response,persistent,reply))=>{
                    let result=if active.as_ref().is_none_or(|token|token.is_cancelled()){Err(Error::ApprovalResolved)}else if persistent {inner.store.resolve_approval_persistent(&session,response).await.map(|_|())} else {inner.store.resolve_approval(&session,response).await.map(|_|())};
                    let _=reply.send(result);
                },
                None => break,
            },
            result=tasks.join_next(), if active.is_some() => {
                active=None;
                active_shell=None;
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

/// Erase the drain future's type. Delegation lets a drain create another Session
/// (`drain` -> `delegate` -> `wake_session` -> `coordinate` -> `drain`), which is
/// a type cycle if `coordinate` names the opaque `drain` future directly.
fn boxed_drain(
    session: String,
    inner: Arc<Inner>,
    force: bool,
    cancel: CancellationToken,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send>> {
    Box::pin(async move {
        let affinity = inner.store.cache_affinity(&session).await?;
        let child = inner.store.lineage_parent(&session).await?.is_some();
        crate::copilot::scoped(
            child,
            crate::cache_affinity::scoped_candidate(
                session.clone(),
                affinity,
                drain(session, inner, force, cancel),
            ),
        )
        .await
    })
}

/// How long a drain's Session claim stays valid without renewal.
const SESSION_LEASE_MS: i64 = 30_000;

/// Marks a Session as draining for the timer heartbeat's duration check.
struct DrainingGuard(Arc<Inner>, String);
impl Drop for DrainingGuard {
    fn drop(&mut self) {
        if let Ok(mut draining) = self.0.draining.lock() {
            draining.remove(&self.1);
        }
    }
}

/// Aborts the renewal task when the drain ends, including on an early return.
struct LeaseKeepalive(JoinHandle<()>);
impl Drop for LeaseKeepalive {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Renew the drain's claim and consume cross-process cancel requests until the
/// turn ends. A superseded owner, or one another window asked to stop, cancels
/// its own work instead of continuing.
async fn keep_lease(
    store: Store,
    lease: SessionLease,
    run: String,
    cursor: u64,
    cancel: CancellationToken,
) {
    let mut ticks = 0u32;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
        }
        // Another window can only reach this run through the durable request.
        if store
            .cancel_requested(&lease.session, &run, cursor)
            .await
            .unwrap_or(false)
        {
            cancel.cancel();
            return;
        }
        ticks += 1;
        if ticks.is_multiple_of(8) && store.renew_session(&lease, SESSION_LEASE_MS).await.is_err() {
            cancel.cancel();
            return;
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
    if let Ok(mut draining) = inner.draining.lock() {
        draining.insert(session.clone());
    }
    let _draining = DrainingGuard(inner.clone(), session.clone());
    // Cursor before the claim: a cancel request written in between still counts.
    let cursor = inner.store.latest_seq(&session).await?;
    let lease = inner
        .store
        .claim_session(&session, SESSION_LEASE_MS)
        .await?;
    // The lease is ours now, so a run still marked running belongs to a process
    // that lost it. Reconcile it before opening a new run; otherwise the active
    // run index would reject the start.
    inner.store.recover_session(Some(&session)).await?;
    // Message tail before this drain promotes its inputs: a terminal
    // first-turn provider rejection quarantines exactly what it promoted.
    let history_base = inner.store.max_message_seq(&session).await?;
    let promoted = inner.store.promote_fenced(&session, true, &lease).await?;
    if promoted.is_empty() && !force {
        return Ok(());
    }
    if inner.store.history(&session).await?.is_empty() {
        return Err(Error::Invalid("Session has no admitted history".into()));
    }
    let run = uuid::Uuid::new_v4().to_string();
    inner.store.start_run_fenced(&session, &run, &lease).await?;
    let _keepalive = LeaseKeepalive(tokio::spawn(keep_lease(
        inner.store.clone(),
        lease.clone(),
        run.clone(),
        cursor,
        cancel.clone(),
    )));
    if inner.started.lock().await.insert(session.clone()) {
        inner
            .store
            .record(
                &session,
                crate::events::Lifecycle::SessionStart.name(),
                json!({"run_id":run}),
            )
            .await?;
    }
    record_promotions(&inner, &session, &run, &promoted, &lease).await?;
    let result = execute(&session, &run, &inner, cancel.clone(), &lease, history_base).await;
    let reason = if cancel.is_cancelled() {
        "interrupted"
    } else if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    inner
        .store
        .finish_run_fenced(&session, &run, reason, &lease)
        .await?;
    let stop = if reason == "failed" {
        crate::events::Lifecycle::StopFailure
    } else {
        crate::events::Lifecycle::Stop
    };
    // `reason` stays the coarse lifecycle category (completed/failed/interrupted).
    // Carry the underlying error text separately so a client can show why the
    // drain failed instead of the bare category.
    let message = match &result {
        Err(error) => Some(error.to_string()),
        Ok(_) => None,
    };
    inner
        .store
        .record(
            &session,
            stop.name(),
            json!({"run_id":run,"reason":reason,"message":message}),
        )
        .await?;
    // A settled run must not leave the host executing product-tool calls for a
    // parent that is gone: cancel, failure, and clean end each notify every
    // call still pending on the bridge.
    let bridge = inner.product.read().unwrap().bridge.clone();
    if let Some(bridge) = bridge {
        bridge.cancel_session(&session).await;
    }
    result
}

/// Emit one UserPromptSubmit per input promoted into visible history.
async fn record_promotions(
    inner: &Inner,
    session: &str,
    run: &str,
    promoted: &[crate::protocol::Event],
    lease: &SessionLease,
) -> Result<(), Error> {
    for event in promoted {
        inner
            .store
            .record_fenced(
                session,
                crate::events::Lifecycle::UserPromptSubmit.name(),
                json!({"run_id":run,"input_id":event.data["input_id"]}),
                lease,
            )
            .await?;
    }
    Ok(())
}

/// Paths a successful mutating tool changed, in workspace-relative form.
fn touched_paths(name: &str, input: &Value) -> Vec<String> {
    match name {
        "write_file" | "edit_file" => input["path"]
            .as_str()
            .map(|path| vec![path.to_owned()])
            .unwrap_or_default(),
        "apply_patch" => input["patch"]
            .as_str()
            .map(|patch| {
                patch
                    .lines()
                    .filter_map(|line| {
                        ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                            .iter()
                            .find_map(|prefix| line.strip_prefix(prefix))
                    })
                    .map(|path| path.trim().to_owned())
                    .filter(|path| !path.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The transport-level outcome of the request that just failed, read back from
/// the durable `provider.request.result` fact, so the failure record carries
/// the provider's own error body instead of a bare status. Absent for
/// in-process providers that never cross HTTP.
async fn provider_failure_detail(
    store: &Store,
    session: &str,
    run: &str,
    step: u64,
) -> Option<Value> {
    let event = store
        .latest_event(session, "provider.request.result")
        .await
        .ok()??;
    if event.data["run_id"].as_str() != Some(run) || event.data["step"].as_u64() != Some(step) {
        return None;
    }
    let status = event.data["http_status"].as_u64()?;
    if status < 400 {
        return None;
    }
    let mut detail = json!({"http_status": status});
    if let Some(body) = event.data["response_body"].as_str() {
        if !body.is_empty() {
            let mut body = body.to_owned();
            if body.len() > 2000 {
                let mut cut = 2000;
                while !body.is_char_boundary(cut) {
                    cut -= 1;
                }
                body.truncate(cut);
            }
            detail["response_body"] = json!(body);
        }
    }
    Some(detail)
}

/// The provider's own error words for the failure line, parsed from the
/// recorded response body (for example `{"error":{"code":"1210",
/// "message":"图片输入格式/解析错误"}}`). Non-JSON bodies stay unparsed.
fn provider_error_text(detail: &Value) -> Option<String> {
    let body = detail["response_body"].as_str()?;
    let parsed: Value = serde_json::from_str(body).ok()?;
    let message = parsed["error"]["message"].as_str()?;
    match parsed["error"]["code"].as_str() {
        Some(code) => Some(format!("{message} (code {code})")),
        None => Some(message.to_owned()),
    }
}

async fn execute(
    session: &str,
    run: &str,
    inner: &Arc<Inner>,
    cancel: CancellationToken,
    lease: &SessionLease,
    history_base: u64,
) -> Result<(), Error> {
    let mut step = 0;
    let mut allowance = inner.policy.max_provider_turns();
    let mut reset_allowance = true;
    let mut input_corrections = 0;
    let mut transport_continuations = 0;
    // Consecutive provider turns that produced neither text nor tool calls.
    let mut empty_completions = 0;
    // Consecutive failed completion checks for the configured verification.
    let mut verification_failures = 0;
    let mut repeats = HashMap::<String, u32>::new();
    // A moved product-tool reply ends the run at its boundary; set only by
    // the bridge arm, checked after each provider turn's tool batch.
    let mut moved = false;
    let mut verification_scope = crate::verification::Scope::default();
    let mut internal_inputs = HashSet::new();
    let mut goal_iterations = 0;
    let mut goal_stalls = 0;
    let mut goal_signature = None;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        loop {
            command::prepare_pending(inner, session, run, lease, cancel.clone()).await?;
            if cancel.is_cancelled() {
                return Ok(());
            }
            let promoted = inner.store.promote_fenced(session, false, lease).await?;
            if promoted.is_empty() {
                break;
            }
            record_promotions(inner, session, run, &promoted, lease).await?;
            reset_allowance = true;
        }
        // A host-resolved agent (ADR-0017) applies at this boundary: its pinned
        // model only while the Session has no explicit selection of its own.
        let agent = inner.store.agent(session).await?;
        let manifest = agent.as_ref().map(|(manifest, _)| manifest);
        let policy = inner.policy.for_agent(manifest)?;
        // A newly promoted external input gets the selected agent's whole
        // allowance, even if that input also switched agents. Internal loop
        // continuations never reset it.
        allowance = if reset_allowance {
            policy.max_provider_turns()
        } else {
            allowance.min(policy.max_provider_turns())
        };
        reset_allowance = false;
        if allowance == 0 {
            // Exhausting the allowance pauses the drain; it is not a provider
            // failure. End the run cleanly and leave a visible history fact so
            // the transcript explains the pause. The next promoted input
            // resets the allowance and continues.
            inner
                .store
                .inject(
                    session,
                    &format!("allowance-{run}"),
                    "Reached the provider turn allowance for this prompt. Send a message to continue.",
                    "engine",
                )
                .await?;
            return Ok(());
        }
        allowance -= 1;
        let binding = match (inner.store.model_selection(session).await?, agent.as_ref()) {
            (Some(selection), _) => Some(selection),
            (None, Some((manifest, _))) => manifest.model.clone(),
            (None, None) => None,
        };
        let account = inner.store.account_selection(session).await?;
        let binding = match account.as_ref() {
            Some(account) => crate::session_account::resolve(
                &inner.provider,
                binding.as_ref(),
                account.credential_id.as_deref(),
            )?,
            None => binding,
        };
        let selected_provider = crate::session_model::select(&inner.provider, binding.as_ref())?;
        let provider = match manifest.and_then(|agent| agent.request.as_ref()) {
            Some(request) => selected_provider
                .with_request_options(request.clone())
                .map_err(|error| Error::Invalid(error.to_string()))?,
            None => selected_provider,
        };
        let mut bundle = match crate::context::assemble_for_agent(
            &inner.tools,
            &policy,
            cancel.child_token(),
            manifest,
        )
        .await
        {
            Ok(bundle) => bundle,
            Err(ToolError::Interrupted) => return Ok(()),
            Err(error) => return Err(Error::Invalid(format!("context assembly failed: {error}"))),
        };
        if cancel.is_cancelled() {
            return Ok(());
        }
        let mode = match agent.as_ref().and_then(|(manifest, _)| manifest.mode) {
            Some(mode) => mode,
            None => inner.store.mode(session).await?,
        };
        let plan = mode == crate::protocol::CollaborationMode::Plan;
        let mut system = bundle.system.clone();
        if plan {
            system.push_str("\n\n<collaboration-mode mode=\"plan\">\nYou are in plan mode: investigate and propose a plan. Do not modify files, run commands, or start background work; those capabilities are denied.\n</collaboration-mode>");
        }
        if let Some((manifest, _)) = &agent {
            if let Some(instructions) = manifest
                .instructions
                .as_deref()
                .filter(|text| !text.trim().is_empty())
            {
                system.push_str(&format!(
                    "\n\n<agent name=\"{}\">\n{}\n</agent>",
                    manifest.attribute(),
                    instructions
                ));
            }
        }
        if let Some((manifest, hash)) = &agent {
            if system.len() > 65536 {
                return Err(Error::Invalid(
                    "agent instructions exceed system context budget".into(),
                ));
            }
            bundle.system = system.clone();
            bundle
                .sources
                .push(json!({"type":"agent","name":manifest.name,"agent_hash":hash}));
            bundle.fingerprint =
                crate::permission::context_digest(&bundle.system, &bundle.sources)?;
        }
        let sources = bundle.sources.clone();
        let context_epoch = inner
            .store
            .select_context_fenced(session, bundle, lease)
            .await?;
        inner
            .store
            .record(
                session,
                crate::events::Lifecycle::InstructionsLoaded.name(),
                json!({"run_id":run,"sources":sources}),
            )
            .await?;
        let (mut history, state) = inner.store.selected_input(session).await?;
        crate::session_model::validate_history(&history, binding.as_ref(), provider.identity())?;
        let state_allowed = policy.evaluate(
            "session_state",
            "@session/state/session_state",
            crate::permission::Access::Read,
        ) == Decision::Allow;
        let state_selection = if state_allowed {
            if !state["todos"].is_null() || !state["goal"].is_null() {
                let ready = crate::state::runnable_state(&state)?;
                let text=format!("<session-state>\n{}\n</session-state>\nRunnable tasks (all prerequisites completed): {}. Waiting jobs block only their dependents; continue independent runnable work. Current durable progress tracking; recorded evidence is a claim, not independent verification. Follow the latest user request.",serde_json::to_string(&state)?,serde_json::to_string(&ready)?);
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
                        checkpoint: None,
                        recorded_at_ms: None,
                    },
                );
            }
            json!({"status":"selected","todos_revision":state["todos"]["revision"],"goal_revision":state["goal"]["revision"],"fingerprint":crate::permission::digest(&serde_json::to_vec(&state)?)})
        } else {
            json!({"status":"skipped","reason":"state_read_policy"})
        };
        // Gate ④ of automatic context management: elide oversized tool output
        // from the outgoing request only. Stored history is untouched, and the
        // knob rides the same `--context-limits` configuration that enables
        // compaction, so an unconfigured runtime sends exactly what it did
        // before.
        if let Some(limits) = &*inner.context.lock().await {
            if let Some(budget) = limits.prune_chars {
                let (elided, dropped) = crate::context_trigger::prune_history(
                    &mut history,
                    budget,
                    limits.protect_turns,
                    limits.prune_total_chars,
                );
                if elided > 0 {
                    let _ = inner.progress.send(json!({
                        "session_id": session, "run_id": run, "step": step,
                        "kind": "context.pruned", "payloads": elided, "characters": dropped,
                    }));
                }
            }
        }
        let started = inner
            .store
            .record(
                session,
                "provider.started",
                json!({"run_id":run,"step":step,"context_epoch":context_epoch,"policy_revision":policy.revision(),"state_selection":state_selection,"identity":provider.identity().map(|i|json!({"protocol":i.protocol,"model":i.model}))}),
            )
            .await?;
        // Durable history retains null plus the error marker for unavailable
        // arguments. Wire schemas require an object; the paired error result
        // explains this placeholder. It is never used for tool execution.
        for message in &mut history {
            for block in message.content.as_array_mut().into_iter().flatten() {
                if block["type"] == "tool_use"
                    && block["input_error"] == "invalid_json"
                    && block["input"].is_null()
                {
                    block["input"] = json!({});
                    if let Some(block) = block.as_object_mut() {
                        block.remove("input_error");
                    }
                }
            }
        }
        // The first request after a compaction checkpoint carries a restore
        // budget note so the model can re-read its working set (see
        // [`crate::history::restore_note`]). Request-scoped: one note only,
        // and the closing user prompt stays last.
        if inner.restore_pending.lock().await.remove(session) {
            let insert_at = match history.last() {
                Some(last) if last.role == "user" => history.len() - 1,
                _ => history.len(),
            };
            history.insert(
                insert_at,
                crate::protocol::Message {
                    role: "user".into(),
                    content: json!([{"type":"text","text":crate::history::restore_note()}]),
                    checkpoint: None,
                    recorded_at_ms: None,
                },
            );
        }
        let named = inner.store.named_agents(session).await?;
        let mut tools = agent_tools(&inner.tools, agent.as_ref(), &policy);
        for tool in &mut tools {
            if tool.name == "task" && !named.is_empty() {
                tool.input_schema["properties"]["agent"] = json!({"type":"string","enum":named.iter().map(|agent|&agent.name).collect::<Vec<_>>()});
            }
        }
        // The plugin `tool.definition` family reviews the assembled surface
        // before it reaches the model, the same reverse dispatch the
        // before/after families use around calls.
        let tools = dispatch_plugin_definitions(inner, session, run, tools).await?;
        let request = ModelRequest {
            system,
            messages: history,
            tools,
        };
        let prefix_through = if inner.context.lock().await.is_some() {
            Some(inner.store.max_message_seq(session).await?)
        } else {
            None
        };
        // A transport failure before any streamed output is safe to replay; once
        // output has been emitted it is not. Retry the bounded pre-output case so
        // a transient reset (for example a proxy dropping the stream) does not
        // fail the turn.
        let mut produced = false;
        let mut ttft_ms: Option<u64> = None;
        let mut attempts = 0;
        let transport_budget = crate::provider::Budget::new();
        let reply = loop {
            let (send, mut receive) = mpsc::channel(64);
            let attempt_started = std::time::Instant::now();
            let response = crate::runtime_profile::scoped(
                crate::runtime_profile::Scope {
                    store: inner.store.clone(),
                    session: session.into(),
                    run: run.into(),
                    step,
                    context_epoch,
                    agent: match &agent {
                        Some((manifest, hash)) => json!({
                            "name": manifest.name,
                            "semantics": manifest.semantics,
                            "agentHash": hash,
                            "collaborationMode": if plan { "plan" } else { "build" },
                        }),
                        None => {
                            json!({"name":"native-runtime","semantics":"native-runtime-v1","collaborationMode":if plan {"plan"} else {"build"}})
                        }
                    },
                    permissions: json!({"policy":policy.descriptor(),"boundary":inner.tools.authority_descriptor()}),
                },
                crate::provider::scoped(
                    transport_budget.clone(),
                    3,
                    provider.stream(request.clone(), send, cancel.child_token()),
                ),
            );
            tokio::pin!(response);
            let outcome = loop {
                tokio::select! {
                    _=cancel.cancelled()=>return Ok(()),
                    reply=&mut response=>break reply,
                    Some(delta)=receive.recv()=>{
                        if delta["kind"] == "provider.retry" {
                            // A retry is a durable product fact that survives replay,
                            // unlike stream deltas, so it is recorded rather than
                            // forwarded on the ephemeral progress channel. It is not
                            // provider output, so it never counts as `produced`.
                            inner.store.record(session,"provider.retry",json!({
                                "run_id":run,"step":step,
                                "attempt":delta["attempt"],"reason":delta["reason"],"status":delta["status"],
                            })).await?;
                        } else if delta["kind"] == "provider.attempt" {
                            // An attempt describes the request, not the answer it may
                            // produce: it travels on the ephemeral progress channel
                            // under its own kind, where an evaluation runner can
                            // observe every attempt. It is not provider output, so it
                            // never counts as `produced` and never disarms the
                            // pre-output transport retry.
                            let _=inner.progress.send(json!({"session_id":session,"run_id":run,"step":step,"kind":"provider.attempt","protocol":delta["protocol"],"attempt":delta["attempt"],"status":delta["status"],"outcome":delta["outcome"],"detail":delta["detail"]}));
                        } else {
                            if !produced {
                                ttft_ms = Some(attempt_started.elapsed().as_millis() as u64);
                            }
                            produced |= crate::first_event::semantic_event(delta.get("raw").unwrap_or(&delta));
                            let _=inner.progress.send(json!({"session_id":session,"run_id":run,"step":step,"kind":"provider.delta","anchor_seq":started.seq,"recorded_at_ms":started.recorded_at_ms,"data":delta}));
                        }
                    },
                }
            };
            // Completion can win select while the final frames are still queued.
            // Deliver every queued fact before committing the response or retrying.
            while let Ok(delta) = receive.try_recv() {
                if delta["kind"] == "provider.retry" {
                    inner.store.record(session, "provider.retry", json!({
                        "run_id":run,"step":step,
                        "attempt":delta["attempt"],"reason":delta["reason"],"status":delta["status"],
                    })).await?;
                } else if delta["kind"] == "provider.attempt" {
                    let _=inner.progress.send(json!({"session_id":session,"run_id":run,"step":step,"kind":"provider.attempt","protocol":delta["protocol"],"attempt":delta["attempt"],"status":delta["status"],"outcome":delta["outcome"],"detail":delta["detail"]}));
                } else {
                    if !produced {
                        ttft_ms = Some(attempt_started.elapsed().as_millis() as u64);
                    }
                    produced |=
                        crate::first_event::semantic_event(delta.get("raw").unwrap_or(&delta));
                    let _ =
                        inner
                            .progress
                            .send(json!({"session_id":session,"run_id":run,"step":step,
                        "kind":"provider.delta","anchor_seq":started.seq,
                        "recorded_at_ms":started.recorded_at_ms,"data":delta}));
                }
            }
            match outcome {
                Err(ProviderError::Transport) | Err(ProviderError::ResponseTransport)
                    if !produced && attempts < 2 =>
                {
                    attempts += 1;
                    continue;
                }
                other => break other,
            }
        };
        let mut reply = match reply {
            Ok(reply) => reply,
            Err(ProviderError::Interrupted) => return Ok(()),
            Err(error) => {
                let detail = provider_failure_detail(&inner.store, session, run, step as u64).await;
                let mut failure = json!({"run_id":run,"step":step,"message":error.to_string(),"routing":error.routing()});
                if let Some(detail) = &detail {
                    failure["provider"] = detail.clone();
                }
                inner
                    .store
                    .record(session, "provider.failed", failure)
                    .await?;
                if cancel.is_cancelled() {
                    return Ok(());
                }
                if let Some((partial, unexecuted_calls)) = error.continuation() {
                    inner
                        .store
                        .record(
                            session,
                            "usage",
                            json!({"run_id":run,"step":step,"usage":partial.usage,"partial":true,"model":binding.as_ref().map(|binding|binding.model.as_str()),"cache":crate::usage::cache_lineage(&partial.usage),"context_message_seq":inner.store.max_message_seq(session).await?}),
                        )
                        .await?;
                    if partial
                        .content
                        .as_array()
                        .is_some_and(|content| !content.is_empty())
                    {
                        inner
                            .store
                            .assistant_reply_fenced(
                                session,
                                run,
                                Some(started.seq),
                                partial.content.clone(),
                                lease,
                            )
                            .await?;
                    }
                    inner
                        .store
                        .record(
                            session,
                            "provider.interrupted",
                            json!({"run_id":run,"step":step,"unexecuted_calls":unexecuted_calls}),
                        )
                        .await?;
                    if cancel.is_cancelled() {
                        return Ok(());
                    }
                    if transport_continuations < 2 && allowance > 0 {
                        transport_continuations += 1;
                        let input_id = format!("transport:{run}:{transport_continuations}");
                        inner.store.admit(crate::protocol::Input {
agent_references: Default::default(),
command: None,
                            session_id: session.into(), input_id: input_id.clone(),
                            prompt: "The provider stream was interrupted by a transport failure. Continue from committed history and retained partial text. Previously completed tools remain completed; do not repeat their side effects. Unfinished local calls from the interrupted response were not dispatched; regenerate only the remaining work.".into(),
                            delivery: crate::protocol::Delivery::Steer,
                        }).await?;
                        internal_inputs.insert(input_id);
                        let promoted = inner.store.promote_fenced(session, false, lease).await?;
                        record_promotions(inner, session, run, &promoted, lease).await?;
                        if promoted.iter().any(|event| {
                            event.data["input_id"]
                                .as_str()
                                .is_none_or(|id| !internal_inputs.contains(id))
                        }) {
                            allowance = policy.max_provider_turns();
                            reset_allowance = true;
                            input_corrections = 0;
                            repeats.clear();
                            transport_continuations = 0;
                            empty_completions = 0;
                            verification_failures = 0;
                            goal_iterations = 0;
                            goal_stalls = 0;
                            goal_signature = None;
                        }
                        inner
                            .store
                            .record(
                                session,
                                "provider.recovery.continuation",
                                json!({"run_id":run,"step":step,"attempt":transport_continuations}),
                            )
                            .await?;
                        step += 1;
                        continue;
                    }
                    inner
                        .store
                        .record(
                            session,
                            "provider.recovery.stopped",
                            json!({"run_id":run,"step":step,"reason":"continuation_budget"}),
                        )
                        .await?;
                }
                // A first-turn provider rejection is aimed at the promoted
                // input itself: keeping it selected would fail every later
                // prompt the same way, which is how a session gets bricked by
                // one bad attachment. Quarantine what this run promoted so the
                // next prompt starts from the last good history; the transcript
                // keeps the message visible next to the failure record.
                if step == 0
                    && !produced
                    && matches!(error, ProviderError::Http(400 | 404 | 413 | 422))
                {
                    inner
                        .store
                        .quarantine_failed_input(session, history_base, &error.to_string())
                        .await?;
                }
                match detail.as_ref().and_then(provider_error_text) {
                    Some(text) => return Err(Error::Invalid(format!("{error}: {text}"))),
                    None => return Err(Error::Invalid(error.to_string())),
                }
            }
        };
        inner
            .store
            .record(
                session,
                "usage",
                json!({"run_id":run,"step":step,"usage":reply.usage,"model":binding.as_ref().map(|binding|binding.model.as_str()),"cache":crate::usage::cache_lineage(&reply.usage),"context_message_seq":inner.store.max_message_seq(session).await?}),
            )
            .await?;
        // The billed turn's settle wall-clock rides the timing side table, so
        // usage reports can order turns in time without timestamps in replayed
        // payloads.
        let _ = inner
            .store
            .record_turn_time(session, run, step as u64, crate::approval::now_ms())
            .await;
        if let Some(ttft_ms) = ttft_ms {
            let _ = inner
                .store
                .record_timing(session, run, step as u64, ttft_ms)
                .await;
            let _ = inner.progress.send(
                json!({"session_id":session,"run_id":run,"step":step,"kind":"provider.ttft","ttft_ms":ttft_ms}),
            );
        }
        crate::session_model::stamp_route(&mut reply.content, binding.as_ref());
        let assistant_boundary = inner
            .store
            .assistant_reply_profiled_fenced(
                session,
                run,
                step,
                Some(started.seq),
                reply.content.clone(),
                provider.reply_identity(&reply),
                lease,
            )
            .await?
            .seq;
        let _ = inner
            .store
            .capture_file_snapshot(session, assistant_boundary)
            .await;
        let invalid_input = reply
            .content
            .as_array()
            .into_iter()
            .flatten()
            .any(|block| block["type"] == "tool_use" && block["input_error"] == "invalid_json");
        if invalid_input {
            input_corrections += 1;
        }
        if reply.needs_tools {
            let mut reads = execute_read_batch(
                inner,
                session,
                run,
                &reply.content,
                cancel.child_token(),
                &policy,
                manifest,
            )
            .await?;
            for block in reply
                .content
                .as_array()
                .ok_or_else(|| Error::Invalid("assistant content".into()))?
            {
                if block["type"] != "tool_use" {
                    continue;
                }
                let id = block["id"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool id".into()))?;
                let name = block["name"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool name".into()))?;
                let effective_name = inner.tools.effective_name(name, &block["input"]);
                if cancel.is_cancelled() && !reads.contains_key(id) {
                    return Ok(());
                }
                if block["input_error"] == "invalid_json" {
                    if !block["input"].is_null()
                        || block["provider_executed"] == true
                        || !inner
                            .tools
                            .definitions()
                            .iter()
                            .any(|tool| tool.name == name)
                    {
                        return Err(Error::Invalid(
                            "unsupported invalid tool input correction".into(),
                        ));
                    }
                    inner.store.tool_result_fenced(session, run, id, json!({"error":"Invalid JSON tool arguments. This call was not executed. Supply a valid JSON object for this call only; do not repeat completed operations."}), true, lease).await?;
                    inner.store.record(session, "tool.input_error", json!({"run_id":run,"step":step,"call_id":id,"tool":name,"reason":"invalid_json","attempt":input_corrections})).await?;
                    continue;
                }
                let batched = reads.contains_key(id);
                let (output, is_error) = if let Some((output, is_error)) = reads.remove(id) {
                    (output, is_error)
                } else {
                    inner
                        .store
                        .record(
                            session,
                            crate::events::Lifecycle::PreToolUse.name(),
                            json!({"run_id":run,"call_id":id,"tool":name}),
                        )
                        .await?;
                    let mut block_input = block["input"].clone();
                    let plugin_before = dispatch_plugin_before(
                        inner,
                        session,
                        run,
                        id,
                        effective_name,
                        &mut block_input,
                    )
                    .await?;
                    if let Some(reason) = plugin_before {
                        (json!({"error":reason}), true)
                    } else {
                        let prepared = inner.tools.prepare(name, block_input).await;
                        match prepared {
                            Err(error) => (json!({"error":error.to_string()}), true),
                            Ok(prepared) => {
                                let allowed = authorize(
                                    inner,
                                    session,
                                    run,
                                    id,
                                    &prepared,
                                    cancel.child_token(),
                                    TurnAuthority {
                                        plan,
                                        policy: &policy,
                                        agent: manifest,
                                    },
                                )
                                .await?;
                                if cancel.is_cancelled() {
                                    return Ok(());
                                }
                                if !allowed {
                                    (json!({"error":"permission denied"}), true)
                                } else if let Some(blocked) = run_hooks(
                                    inner,
                                    session,
                                    crate::events::Lifecycle::PreToolUse,
                                    effective_name,
                                )
                                .await?
                                {
                                    (json!({"error":blocked}), true)
                                } else {
                                    inner
                                        .store
                                        .mark_dispatched_fenced(session, run, id, lease)
                                        .await?;
                                    verification_scope.observe(&prepared);
                                    let touched = touched_paths(name, prepared.input());
                                    let prepared_external =
                                        prepared.access() == crate::permission::Access::External;
                                    let replayed = if let Some(replay) = &inner.tool_replay {
                                        Some(
                                            replay
                                                .take(
                                                    session,
                                                    name,
                                                    if name == "tool_call" {
                                                        &block["input"]
                                                    } else {
                                                        prepared.input()
                                                    },
                                                )
                                                .await?,
                                        )
                                    } else {
                                        None
                                    };
                                    let (executed, replay_error) = if let Some((output, is_error)) =
                                        replayed
                                    {
                                        (Ok(output), Some(is_error))
                                    } else {
                                        let _ = inner.progress.send(json!({
                                            "session_id": session, "run_id": run, "step": step,
                                            "kind": "tool.started", "tool": name,
                                            "resource": prepared.resource(),
                                        }));
                                        (                                match name {
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
                                "knowledge"=>inner.tools.execute_knowledge(prepared,&policy,session,cancel.child_token()).await,
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
                                "task" => {
                                    delegate(
                                        inner,
                                        session,
                                        run,
                                        id,
                                        &prepared,
                                        cancel.child_token(),
                                        Delegation {target:None,referenced_agents:&[],agent:manifest,binding:binding.as_ref(),account:account.as_ref(),model_override:None,attachments:&[],agent_references:&[]},
                                    )
                                    .await
                                }
                                "task_list" => match inner.store.subagents(session).await {
                                    Ok(tasks) => Ok(json!({"tasks":tasks})),
                                    Err(error) => Err(ToolError::External(error.to_string())),
                                },
                                "task_result" => {
                                    match crate::subagent::Selector::parse(prepared.input().clone()) {
                                        Ok(selector) => match inner.store.subagents(session).await {
                                            Ok(tasks) => match tasks.into_iter().find(|task| task["id"].as_str() == Some(&selector.id)) {
                                                Some(task) => {
                                                    let text = task["text"].as_str().filter(|text| !text.is_empty()).unwrap_or(
                                                        if task["status"] == "running" { "Background task is still running." } else { "(no output)" },
                                                    );
                                                    Ok(json!({"task":task,"text":text}))
                                                }
                                                None => Err(ToolError::External("Unknown background task for this Session.".into())),
                                            },
                                            Err(error) => Err(ToolError::External(error.to_string())),
                                        },
                                        Err(error) => Err(error),
                                    }
                                }
                                "task_cancel" => {
                                    match crate::subagent::Selector::parse(prepared.input().clone()) {
                                        Ok(selector) => match inner.store.lineage_parent(&selector.id).await {
                                            Ok(parent) if parent.as_deref() == Some(session) => {
                                                match cancel_session(inner,&selector.id).await {
                                                    Ok(cancelled) => Ok(json!({"cancelled":cancelled})),
                                                    Err(error) => Err(ToolError::External(error.to_string())),
                                                }
                                            }
                                            Ok(_) => Err(ToolError::External("Unknown background task for this Session.".into())),
                                            Err(error) => Err(ToolError::External(error.to_string())),
                                        },
                                        Err(error) => Err(error),
                                    }
                                }
                                "start_job" => {
                                    start_background(inner, session, run, id, prepared).await
                                }
                                "monitor" => {
                                    start_monitor(inner, session, run, id, prepared).await
                                }
                                "terminal_start" => {
                                    inner.tools.start_terminal(&inner.terminals, session, prepared, cancel.child_token()).await
                                }
                                "terminal_read" | "terminal_write" | "terminal_resize" | "terminal_list" | "terminal_stop" => {
                                    inner.terminals.execute(session, name, prepared.input().clone()).await
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
                                "job_list" => {
                                    Ok(json!({"jobs":inner.store.jobs(session).await?}))
                                }
                                "job_wait" => {
                                    match crate::jobs::Wait::parse(prepared.input().clone()) {
                                        Ok(wait) => wait_background(inner, session, &wait, cancel.child_token()).await,
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
                                name if inner.product.read().unwrap().has(name) => {
                                    let input = prepared.input().clone();
                                    let bridge = inner
                                        .product
                                        .read()
                                        .unwrap()
                                        .bridge
                                        .clone();
                                    match bridge {
                                        Some(bridge) => {
                                            // The host names a real permission source from
                                            // the calling assistant message and tool call; a
                                            // cancelled run must not leave it executing for a
                                            // parent that is gone.
                                            let context = crate::product::CallContext {
                                                message_seq: assistant_boundary,
                                                call_id: id.to_owned(),
                                            };
                                            tokio::select! {
                                                biased;
                                                _ = cancel.cancelled() => {
                                                    bridge.cancel_session(session).await;
                                                    Err(ToolError::Interrupted)
                                                }
                                                outcome = bridge.call(session, name, input, context) => match outcome {
                                                    Ok(output) => {
                                                        if output.get("moved").is_some_and(|value| value.as_bool() == Some(true)) {
                                                            moved = true;
                                                        }
                                                        Ok(output)
                                                    }
                                                    Err(error) => Err(error),
                                                },
                                            }
                                        }
                                        None => Err(ToolError::Unsupported),
                                    }
                                }
                                _ => {
                                    let progress =
                                        if prepared.access() == crate::permission::Access::Execute {
                                            let (tx, mut rx) = mpsc::channel::<Value>(16);
                                            let sink = inner.progress.clone();
                                            let session = session.to_owned();
                                            let run = run.to_owned();
                                            tokio::spawn(async move {
                                                while let Some(chunk) = rx.recv().await {
                                                    let _ = sink.send(json!({
                                                        "session_id": session, "run_id": run,
                                                        "step": step, "kind": "tool.progress",
                                                        "output": chunk,
                                                    }));
                                                }
                                            });
                                            Some(tx)
                                        } else {
                                            None
                                        };
                                    inner
                                        .tools
                                        .execute_prepared_with_progress(
                                            prepared,
                                            &policy,
                                            cancel.child_token(),
                                            progress,
                                            Some(&crate::worker::AskBridge {
                                                store: &inner.store,
                                                location: inner.tools.location(),
                                                session,
                                                run,
                                                call: id,
                                            }),
                                        )
                                        .await
                                }
                            }, None)
                                    };
                                    match executed {
                                        Ok(output) => {
                                            let is_error = replay_error.unwrap_or(
                                                (prepared_external && output["isError"] == true)
                                                || (name == "question"
                                                    && output["state"] != "answered")
                                                // Native tools signal rejection through a
                                                // structured error payload that carries
                                                // recovery data, not through Err.
                                                || (!prepared_external
                                                    && output
                                                        .get("error")
                                                        .is_some_and(Value::is_string)),
                                            );
                                            if !is_error {
                                                for path in &touched {
                                                    inner
                                                        .store
                                                        .record_file_touch(session, path)
                                                        .await?;
                                                }
                                            }
                                            (output, is_error)
                                        }
                                        Err(ToolError::Interrupted) => return Ok(()),
                                        Err(error) => (json!({"error":error.to_string()}), true),
                                    }
                                }
                            }
                        }
                    }
                };
                let (output, is_error) = if plugin_marked(inner, "after") {
                    let mut output = output;
                    let mut is_error = is_error;
                    if let Some(reason) = dispatch_plugin_after(
                        inner,
                        session,
                        run,
                        id,
                        effective_name,
                        &block["input"],
                        &mut output,
                    )
                    .await?
                    {
                        output = json!({"error":reason});
                        is_error = true;
                    }
                    (output, is_error)
                } else {
                    (output, is_error)
                };
                let signature = serde_json::to_string(
                    &json!({"name":name,"input":block["input"],"output":output,"is_error":is_error}),
                )?;
                let polling_terminal = name == "terminal_read"
                    && !is_error
                    && output.get("exit").is_some_and(Value::is_null);
                if !batched {
                    inner
                        .store
                        .tool_result(session, run, id, output, is_error)
                        .await?;
                    inner
                        .store
                        .record(
                            session,
                            crate::events::Lifecycle::PostToolUse.name(),
                            json!({"run_id":run,"call_id":id,"tool":name,"is_error":is_error}),
                        )
                        .await?;
                }
                run_hooks(
                    inner,
                    session,
                    crate::events::Lifecycle::PostToolUse,
                    effective_name,
                )
                .await?;
                if polling_terminal {
                    continue;
                }
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
        // A moved product-tool reply (the worktree bridge) means the Session's
        // identity now belongs to another owner process: settle this run
        // cleanly instead of taking another provider turn from a stale root.
        if moved {
            return Ok(());
        }
        if invalid_input && input_corrections <= 2 {
            inner
                .store
                .record(
                    session,
                    "tool.input_recovery.continuation",
                    json!({"run_id":run,"step":step,"attempt":input_corrections}),
                )
                .await?;
        }
        if invalid_input && input_corrections > 2 {
            inner.store.record(session, "tool.input_recovery.stopped", json!({"run_id":run,"step":step,"reason":"correction_budget","attempts":input_corrections})).await?;
            return Err(Error::Invalid(
                "invalid tool JSON correction allowance exceeded".into(),
            ));
        }
        // Boundary reload always follows committed tool results. Steers promote
        // before continuation; queue only when this task would otherwise idle.
        if cancel.is_cancelled() {
            return Ok(());
        }
        // Settled tools do not close a provider continuation: its assistant
        // message still contains tool_use blocks whose results follow the cut.
        // Compact only a completed answer, before admitting newer prompts into
        // the selected history summarized by this checkpoint.
        let closed_answer = !reply.needs_tools
            && reply.content.as_array().is_some_and(|parts| {
                parts.iter().any(|part| {
                    part["type"] == "text"
                        && part["text"].as_str().is_some_and(|text| !text.is_empty())
                })
            });
        // Automatic compaction needs configured limits; an operator request is
        // itself the trigger, so one forced pass runs without them. Both use the
        // same settled boundary and the same summarizer.
        let requested = if closed_answer {
            inner.store.pending_compaction_request(session).await?
        } else {
            None
        };
        let limits = inner.context.lock().await.clone().or_else(|| {
            requested
                .is_some()
                .then(crate::context_trigger::ContextLimits::operator_requested)
        });
        if let Some(limits) = limits.filter(|_| closed_answer) {
            let primary = Arc::clone(&provider);
            let bindings = inner.roles.lock().await.clone();
            let (role_provider, resolution) =
                crate::roles::resolve(&primary, bindings.binding("summarize"));
            // A binding whose model cannot hold the retention slice is checked
            // against the host-declared capacity before the doomed request.
            let role_capacity = match &resolution {
                crate::roles::Resolution::Bound { model } => {
                    inner.route_limits.lock().await.context_limit_for(model)
                }
                _ => None,
            };
            if resolution != crate::roles::Resolution::Primary {
                let _ = inner
                    .store
                    .record(
                        session,
                        "role.bound",
                        json!({"run_id":run,"role":"summarize","resolution":resolution.to_evidence()}),
                    )
                    .await;
            }
            let stop = inner.stop.clone();
            let store = inner.store.clone();
            // An attempt already on the primary model — no binding, or a
            // substituted one — does not escalate to itself (ADR-14): only
            // an accepted binding earns the single retry on the primary.
            let escalate = matches!(resolution, crate::roles::Resolution::Bound { .. });
            let prefix_provider = Arc::clone(&role_provider);
            let prefix_allowed = prefix_provider.supports_tool_free_stream()
                && prefix_provider
                    .identity()
                    .zip(primary.identity())
                    .is_some_and(|(role, main)| role == main)
                && prefix_through.is_some();
            let mut summarize = move |body: String| {
                let role_provider = Arc::clone(&role_provider);
                let primary = Arc::clone(&primary);
                let stop = stop.clone();
                let store = store.clone();
                async move {
                    crate::roles::summarize_with_escalation(
                        &role_provider,
                        &primary,
                        &crate::roles::Settlement {
                            store: &store,
                            session,
                            run,
                        },
                        &stop,
                        &body,
                        escalate,
                        role_capacity,
                    )
                    .await
                }
            };
            let mut notify = |notice: Value| {
                let _ = inner.progress.send(notice);
            };
            // Gate ②: the runtime owns the provider, so the counter that prices
            // the messages appended since the anchor is bound here.
            let counting = Arc::clone(&provider);
            let mut count = move |messages: Vec<crate::protocol::Message>| -> std::pin::Pin<
                Box<dyn std::future::Future<Output = crate::provider::CountTokens> + Send>,
            > {
                let counting = Arc::clone(&counting);
                Box::pin(async move {
                    counting
                        .count_tokens(&ModelRequest {
                            system: String::new(),
                            messages,
                            tools: Vec::new(),
                        })
                        .await
                })
            };
            let mut breaker = inner.breaker.lock().await;
            let mut prefix = || {
                let provider = Arc::clone(&prefix_provider);
                let store = inner.store.clone();
                let stop = inner.stop.clone();
                let mut snapshot = request.clone();
                let permissions = json!({"policy":policy.descriptor(),"boundary":inner.tools.authority_descriptor()});
                async move {
                    if !prefix_allowed {
                        return None;
                    }
                    let tail = match store
                        .pending_context(session, prefix_through.unwrap_or(0))
                        .await
                    {
                        Ok((messages, _)) => messages,
                        Err(error) => return Some(Err(error.to_string())),
                    };
                    snapshot.messages.extend(tail);
                    Some(crate::runtime_profile::scoped(
                        crate::runtime_profile::Scope {
                            store:store.clone(),session:session.into(),run:run.into(),step,context_epoch,
                            agent:json!({"name":"native-summary","semantics":"prefix-summary-v1"}),permissions,
                        },
                        crate::roles::summarize_prefix(&provider,&crate::roles::Settlement { store:&store,session,run },&stop,snapshot),
                    ).await)
                }
            };
            // A durable operator request forces one pass at this boundary even
            // when the budget gate is under threshold, and resets the breaker so
            // a repaired summarizer gets its fresh try — the same semantics the
            // host-supplied `compact` command has.
            if requested.is_some() {
                breaker.reset();
            }
            let compacted = crate::context_trigger::maybe_compact_with_prefix(
                &inner.store,
                crate::context_trigger::CompactRequest {
                    session,
                    run,
                    boundary: assistant_boundary,
                    forced: requested.is_some(),
                    budget: &limits.budget(),
                    per_pass: limits.per_pass,
                    breaker: &mut breaker,
                    notify: &mut notify,
                    count: &mut count,
                },
                &mut summarize,
                &mut prefix,
            )
            .await
            .unwrap_or(false);
            if compacted {
                // The next provider request rides the restore budget note.
                inner
                    .restore_pending
                    .lock()
                    .await
                    .insert(session.to_owned());
            }
            if let Some(seq) = requested {
                // One attempt answers the request either way, so a summarizer the
                // provider keeps refusing cannot pin the Session: asking again is
                // what asks for another try.
                let _ = inner
                    .store
                    .settle_compaction_request(session, seq, compacted)
                    .await;
            }
        }
        let mut promoted = inner
            .store
            .promote_fenced(session, !reply.needs_tools, lease)
            .await?;
        let mut goal_stopped_this_turn = false;
        if !reply.needs_tools && promoted.is_empty() && state_allowed {
            let state = inner.store.state(session).await?;
            let goal = &state["goal"]["value"];
            if goal["status"] == "active"
                && goal["autonomous"] == true
                && !crate::state::runnable_state(&state)?.is_empty()
            {
                let signature = serde_json::to_string(&state["todos"]["value"]["todos"])?;
                goal_stalls = if goal_signature.as_ref() == Some(&signature) {
                    goal_stalls + 1
                } else {
                    0
                };
                goal_signature = Some(signature);
                let reason = if allowance == 0 {
                    Some("budget")
                } else if goal_iterations >= 25 {
                    Some("max-iterations")
                } else if goal_stalls >= 2 {
                    Some("no-progress")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    goal_stopped_this_turn = true;
                    inner
                        .store
                        .record(
                            session,
                            "loop.stopped",
                            json!({"run_id":run,"reason":reason}),
                        )
                        .await?;
                } else {
                    goal_iterations += 1;
                    let input_id = format!("goal:{run}:{goal_iterations}");
                    let admission = inner.store.admit(Input {
agent_references: Default::default(),
command: None,
                            session_id: session.into(), input_id: input_id.clone(),
                            prompt: "Continue the next dependency-ready todo independently of background waits. Choose only tasks whose depends_on prerequisites are completed. Preserve completed operations, make concrete progress, and update the todo list. If no task is runnable, wait for existing completion notifications rather than polling.".into(),
                            delivery: crate::protocol::Delivery::Queue,
                        }).await?;
                    internal_inputs.insert(input_id.clone());
                    inner.store.record(session, "loop.continuation", json!({"run_id":run,"input_id":input_id,"admitted_seq":admission.admitted_seq,"iteration":goal_iterations})).await?;
                    promoted = inner.store.promote_fenced(session, true, lease).await?;
                }
            }
        }
        // An empty completion is a wasted turn: the provider ended its turn
        // with neither text nor tool calls, so nothing advanced. One bounded
        // reminder continues the run; a second consecutive empty completion is
        // a classified closure instead of a silent one.
        let reply_text_empty = reply.content.as_array().is_none_or(|blocks| {
            blocks.iter().all(|block| {
                block["type"] != "text"
                    || block["text"]
                        .as_str()
                        .is_none_or(|text| text.trim().is_empty())
            })
        });
        if !reply.needs_tools && promoted.is_empty() && !goal_stopped_this_turn && reply_text_empty
        {
            if empty_completions == 0 {
                empty_completions += 1;
                let input_id = format!("empty:{run}");
                let admission = inner
                    .store
                    .admit(Input {
agent_references: Default::default(),
command: None,
                        session_id: session.into(),
                        input_id: input_id.clone(),
                        prompt: "Your previous reply contained neither text nor tool calls, so nothing advanced. Continue the task now: act with a tool, or state the final result explicitly.".into(),
                        delivery: crate::protocol::Delivery::Queue,
                    })
                    .await?;
                internal_inputs.insert(input_id);
                inner
                    .store
                    .record(
                        session,
                        "loop.continuation",
                        json!({"run_id":run,"admitted_seq":admission.admitted_seq,"reason":"empty-completion"}),
                    )
                    .await?;
                promoted = inner.store.promote_fenced(session, true, lease).await?;
                record_promotions(inner, session, run, &promoted, lease).await?;
            } else {
                inner
                    .store
                    .record(
                        session,
                        "loop.stopped",
                        json!({"run_id":run,"reason":"empty-completion"}),
                    )
                    .await?;
                return Err(Error::Invalid(
                    "provider returned an empty completion twice".into(),
                ));
            }
        }
        // Task-specific completion check: when a verification command is
        // configured, a run may not finish until it passes. A failure is a
        // classified continuation carrying the bounded output, and the retry
        // budget turns a persistent failure into a classified closure.
        if !reply.needs_tools && promoted.is_empty() && !goal_stopped_this_turn {
            let command = inner.verification.lock().await.clone();
            if let Some(command) = command {
                // The configured value is a command line, so the check runs
                // through the platform shell inside the sandbox: cmd on
                // Windows, sh elsewhere. bash.exe is not guaranteed to exist or
                // to be reachable there.
                let argv = if cfg!(windows) {
                    json!(["cmd", "/c", command])
                } else {
                    json!(["sh", "-c", command])
                };
                let started_at = now_ms();
                let state = inner.store.state(session).await?;
                let task_before = json!({"goal_revision":state["goal"]["revision"],"todos_revision":state["todos"]["revision"]});
                let source_before = inner.tools.verification_source(&verification_scope).await;
                inner.store.record(session,"verification.started",json!({"run_id":run,"attempt":verification_failures+1,"command":command,"cwd":inner.tools.location(),"started_at":started_at,"source":source_before,"task":task_before})).await?;
                let result = match inner
                    .tools
                    .prepare("run_command", json!({"argv":argv}))
                    .await
                {
                    Err(error) => json!({"error":error.to_string()}),
                    Ok(prepared) => match inner
                        .tools
                        .execute_prepared(prepared, &policy, cancel.child_token(), None)
                        .await
                    {
                        Err(error) => json!({"error":error.to_string()}),
                        Ok(value) => value,
                    },
                };
                let source_after = inner.tools.verification_source(&verification_scope).await;
                let state = inner.store.state(session).await?;
                let task_after = json!({"goal_revision":state["goal"]["revision"],"todos_revision":state["todos"]["revision"]});
                let task_stable = task_before == task_after;
                let source_stable =
                    source_before == source_after && source_after["complete"] == true;
                let command_passed =
                    result.get("error").is_none() && result["exit_code"].as_i64() == Some(0);
                let cancelled = cancel.is_cancelled();
                let accepted = command_passed && source_stable && task_stable && !cancelled;
                let receipt = inner.store.record(session,"verification.completed",json!({"run_id":run,"attempt":verification_failures+1,"command":command,"started_at":started_at,"completed_at":now_ms(),"source_before":source_before,"source_after":source_after,"source_stable":source_stable,"task_before":task_before,"task_after":task_after,"task_stable":task_stable,"command_passed":command_passed,"accepted":accepted,"cancelled":cancelled,"result":result})).await?;
                if cancel.is_cancelled() {
                    return Ok(());
                }
                let detail = (!accepted).then(||json!({"result":result,"source_stable":source_stable,"task_stable":task_stable,"note":"A successful exit validates this check only at its recorded source/task scope; changed or unavailable tracked sources or changed task revisions require another check."}).to_string());
                if let Some(detail) = detail {
                    verification_failures += 1;
                    inner
                        .store
                        .record(
                            session,
                            "verification.failed",
                            json!({"run_id":run,"attempt":verification_failures,"receipt_seq":receipt.seq}),
                        )
                        .await?;
                    // One repair chance: the second consecutive failure closes
                    // the run instead of admitting another continuation.
                    if verification_failures >= 2 {
                        inner
                            .store
                            .record(
                                session,
                                "loop.stopped",
                                json!({"run_id":run,"reason":"verification-failed"}),
                            )
                            .await?;
                        return Err(Error::Invalid(
                            "verification failed after the retry budget".into(),
                        ));
                    }
                    let input_id = format!("verify:{run}:{verification_failures}");
                    let admission = inner
                        .store
                        .admit(Input {
                            agent_references: Default::default(),
                            command: None,
                            session_id: session.into(),
                            input_id: input_id.clone(),
                            prompt: format!(
                                "The completion check failed:\n{}\nRepair the cause, then stop.",
                                detail.chars().take(500).collect::<String>()
                            ),
                            delivery: crate::protocol::Delivery::Steer,
                        })
                        .await?;
                    internal_inputs.insert(input_id);
                    inner
                        .store
                        .record(
                            session,
                            "loop.continuation",
                            json!({"run_id":run,"admitted_seq":admission.admitted_seq,"reason":"verification-failed"}),
                        )
                        .await?;
                    promoted = inner.store.promote_fenced(session, true, lease).await?;
                    record_promotions(inner, session, run, &promoted, lease).await?;
                } else {
                    inner
                        .store
                        .record(
                            session,
                            "verification.passed",
                            json!({"run_id":run,"receipt_seq":receipt.seq}),
                        )
                        .await?;
                }
            }
        }
        if !reply.needs_tools && promoted.is_empty() {
            if let Some(replay) = &inner.tool_replay {
                replay.assert_consumed().await?;
            }
            return Ok(());
        }
        if !promoted.is_empty() {
            record_promotions(inner, session, run, &promoted, lease).await?;
            // Synthetic internal admissions are durable, but do not refill the
            // user-input provider allowance. External admissions still do.
            if promoted.iter().any(|event| {
                event.data["input_id"]
                    .as_str()
                    .is_none_or(|id| !internal_inputs.contains(id))
            }) {
                allowance = policy.max_provider_turns();
                reset_allowance = true;
                input_corrections = 0;
                transport_continuations = 0;
                empty_completions = 0;
                verification_failures = 0;
                repeats.clear();
                goal_iterations = 0;
                goal_stalls = 0;
                goal_signature = None;
            }
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
    let next = data["first_occurrence_ms"]
        .as_u64()
        .ok_or_else(|| Error::Invalid("cron occurrence missing".into()))?;
    let expires = data["expires_at_ms"]
        .as_u64()
        .ok_or_else(|| Error::Invalid("cron lifetime missing".into()))?;
    drop(crons);
    let background = spawn_cron_task(
        inner,
        session.to_owned(),
        id.clone(),
        pattern,
        recurring,
        next,
        expires,
    );
    let mut crons = inner.crons.lock().await;
    crons.insert(id, background);
    Ok(Ok(data))
}

/// (Re-)arm a durable cron from stored schedule fields. Shared by the
/// create path and process restart adoption.
#[allow(clippy::too_many_arguments)]
fn spawn_cron_task(
    inner: &Arc<Inner>,
    source: String,
    cron_id: String,
    pattern: String,
    recurring: bool,
    mut next: u64,
    expires: u64,
) -> Background {
    let anchor = chrono::Local::now();
    let anchor_ms = anchor.timestamp_millis() as u64;
    let clock = tokio::time::Instant::now();
    let cancel = inner.stop.child_token();
    let token = cancel.clone();
    let owner = inner.clone();
    let background_source = source.clone();
    let source = source.clone();
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
    Background {
        session: background_source,
        cancel,
        join,
    }
}
/// Stop every in-process task a Session owns, before its rows are deleted.
async fn stop_session(inner: &Arc<Inner>, session: &str) {
    let (jobs, timers, crons) = tokio::join!(
        take_session_background(&inner.jobs, session),
        take_session_background(&inner.timers, session),
        take_session_background(&inner.crons, session),
    );
    inner.started.lock().await.remove(session);
    inner.terminals.close_session(session).await;
    let backgrounds = jobs
        .into_iter()
        .chain(timers)
        .chain(crons)
        .collect::<Vec<_>>();
    for background in &backgrounds {
        background.cancel.cancel();
    }
    for background in backgrounds {
        let _ = background.join.await;
    }
}

/// Take the background tasks of one Session out of an id-keyed table.
async fn take_session_background(
    table: &Mutex<HashMap<String, Background>>,
    session: &str,
) -> Vec<Background> {
    let mut table = table.lock().await;
    let keys = table
        .iter()
        .filter(|(_, background)| background.session == session)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    keys.into_iter()
        .filter_map(|key| table.remove(&key))
        .collect()
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
    drop(timers);
    let background = arm_wakeup(
        inner,
        session.to_owned(),
        id.clone(),
        data["due_at_ms"].as_u64().unwrap_or(now_ms()),
    );
    let mut timers = inner.timers.lock().await;
    timers.insert(id, background);
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

/// (Re-)arm a durable wakeup from its stored due time. Shared by the
/// schedule tool path and process restart adoption.
fn arm_wakeup(inner: &Arc<Inner>, source: String, timer_id: String, due_at_ms: u64) -> Background {
    let delay = due_at_ms.saturating_sub(now_ms());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(delay);
    let cancel = inner.stop.child_token();
    let token = cancel.clone();
    let owner = inner.clone();
    let timer_id = timer_id.clone();
    let background_source = source.clone();
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
    Background {
        session: background_source,
        cancel,
        join,
    }
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

/// Whether the host resolves the plugin hook family `kind`. A marker without a
/// bridge cannot dispatch and fails closed at the call site.
fn plugin_marked(inner: &Inner, kind: &str) -> bool {
    inner
        .product
        .read()
        .unwrap()
        .marker
        .as_ref()
        .is_some_and(|marker| marker.marked(kind))
}

/// One reverse hook dispatch: identifies the journaled outcome of a
/// `hook_tool` exchange for a single tool call.
struct HookTool<'a> {
    inner: &'a Inner,
    session: &'a str,
    run: &'a str,
    call: &'a str,
    kind: &'a str,
    tool: &'a str,
}

impl HookTool<'_> {
    async fn record(
        &self,
        outcome: &str,
        reason: Option<&str>,
        started: std::time::Instant,
    ) -> Result<(), Error> {
        self.inner
            .store
            .record(
                self.session,
                "hook_tool.completed",
                json!({
                    "run_id": self.run,
                    "call_id": self.call,
                    "kind": self.kind,
                    "tool": self.tool,
                    "outcome": outcome,
                    "reason": reason.unwrap_or("ok"),
                    "duration_ms": started.elapsed().as_millis() as u64,
                }),
            )
            .await
            .map(|_| ())
    }
}

/// Reverse-dispatch the plugin `tool.definition` family over the assembled
/// agent surface. A `deny` verdict drops the tool; a `definition` verdict
/// replaces it. A failed dispatch keeps the tool, matching the TypeScript
/// runner's rule that one failing plugin cannot break a provider turn.
async fn dispatch_plugin_definitions(
    inner: &Inner,
    session: &str,
    run: &str,
    tools: Vec<crate::protocol::ToolDefinition>,
) -> Result<Vec<crate::protocol::ToolDefinition>, Error> {
    if !plugin_marked(inner, "definition") {
        return Ok(tools);
    }
    let bridge = inner.product.read().unwrap().bridge.clone();
    let Some(bridge) = bridge else {
        return Ok(tools);
    };
    let mut surfaced = Vec::with_capacity(tools.len());
    for tool in tools {
        let started = std::time::Instant::now();
        let hook = HookTool {
            inner,
            session,
            run,
            call: "",
            kind: "definition",
            tool: &tool.name,
        };
        let payload = serde_json::to_value(&tool)
            .map(|value| json!({"definition": value}))
            .unwrap_or_else(|_| json!({}));
        match bridge
            .call_hook(session, "definition", &tool.name, "", payload)
            .await
        {
            Ok(reply) => {
                if let Some(reason) = reply.get("deny").and_then(Value::as_str) {
                    hook.record("denied", Some(reason), started).await?;
                    continue;
                }
                hook.record("completed", None, started).await?;
                let mut reviewed = tool;
                if let Some(transformed) = reply.get("definition") {
                    if let Ok(parsed) = serde_json::from_value::<crate::protocol::ToolDefinition>(
                        transformed.clone(),
                    ) {
                        reviewed = parsed;
                    }
                }
                surfaced.push(reviewed);
            }
            Err(error) => {
                hook.record("failed", Some(&error.to_string()), started)
                    .await?;
                surfaced.push(tool);
            }
        }
    }
    Ok(surfaced)
}

/// Reverse-dispatch the plugin `tool.execute.before` family. `None` allows the
/// call (the input possibly transformed in place); `Some(reason)` denies it,
/// either by host verdict or because the dispatch failed closed.
async fn dispatch_plugin_before(
    inner: &Inner,
    session: &str,
    run: &str,
    call: &str,
    tool: &str,
    input: &mut Value,
) -> Result<Option<String>, Error> {
    if !plugin_marked(inner, "before") {
        return Ok(None);
    }
    let started = std::time::Instant::now();
    let bridge = inner.product.read().unwrap().bridge.clone();
    let dispatched = match bridge {
        Some(bridge) => {
            bridge
                .call_hook(
                    session,
                    "before",
                    tool,
                    call,
                    json!({"args": input.clone()}),
                )
                .await
        }
        None => Err(crate::tools::ToolError::External(
            "hook bridge missing".into(),
        )),
    };
    match dispatched {
        Ok(reply) => {
            let verdict = reply.get("deny").and_then(Value::as_str).map(String::from);
            if verdict.is_none() {
                if let Some(transformed) = reply.get("args") {
                    *input = transformed.clone();
                }
            }
            HookTool {
                inner,
                session,
                run,
                call,
                kind: "before",
                tool,
            }
            .record(
                if verdict.is_some() { "denied" } else { "ok" },
                verdict.as_deref(),
                started,
            )
            .await?;
            Ok(verdict)
        }
        Err(error) => {
            let reason = format!("tool.execute.before hook unavailable: {error}");
            HookTool {
                inner,
                session,
                run,
                call,
                kind: "before",
                tool,
            }
            .record("error", Some(&reason), started)
            .await?;
            Ok(Some(reason))
        }
    }
}

/// Reverse-dispatch the plugin `tool.execute.after` family against a settled
/// output. `Some(reason)` turns the result into a tool error; `None` keeps it,
/// possibly replaced in place by the host verdict.
async fn dispatch_plugin_after(
    inner: &Inner,
    session: &str,
    run: &str,
    call: &str,
    tool: &str,
    args: &Value,
    output: &mut Value,
) -> Result<Option<String>, Error> {
    if !plugin_marked(inner, "after") {
        return Ok(None);
    }
    let started = std::time::Instant::now();
    let bridge = inner.product.read().unwrap().bridge.clone();
    let dispatched = match bridge {
        Some(bridge) => {
            bridge
                .call_hook(
                    session,
                    "after",
                    tool,
                    call,
                    json!({"args": args.clone(), "output": output.clone()}),
                )
                .await
        }
        None => Err(crate::tools::ToolError::External(
            "hook bridge missing".into(),
        )),
    };
    match dispatched {
        Ok(reply) => {
            let verdict = reply.get("deny").and_then(Value::as_str).map(String::from);
            if verdict.is_none() {
                if let Some(replaced) = reply.get("output") {
                    *output = replaced.clone();
                }
            }
            HookTool {
                inner,
                session,
                run,
                call,
                kind: "after",
                tool,
            }
            .record(
                if verdict.is_some() { "denied" } else { "ok" },
                verdict.as_deref(),
                started,
            )
            .await?;
            Ok(verdict)
        }
        Err(error) => {
            let reason = format!("tool.execute.after hook unavailable: {error}");
            HookTool {
                inner,
                session,
                run,
                call,
                kind: "after",
                tool,
            }
            .record("error", Some(&reason), started)
            .await?;
            Ok(Some(reason))
        }
    }
}

async fn run_hooks(
    inner: &Inner,
    session: &str,
    phase: crate::events::Lifecycle,
    tool: &str,
) -> Result<Option<String>, Error> {
    let hooks = inner.tools.hooks();
    if hooks.is_empty() {
        return Ok(None);
    }
    let mut blocked = None;
    for hook in hooks.iter().filter(|hook| hook.matches(phase, tool)) {
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
        if phase == crate::events::Lifecycle::PreToolUse && outcome != "ok" && blocked.is_none() {
            blocked = Some(format!("blocked by pre_tool_use hook (outcome {outcome})"));
        }
    }
    Ok(blocked)
}

/// More restrictive wins when folding a multi-file tool's per-target verdicts.
fn severity(decision: Decision) -> u8 {
    match decision {
        Decision::Allow => 0,
        Decision::Ask => 1,
        Decision::Deny => 2,
    }
}

/// Delegate a task to a child Session: create the child with lineage, admit the
/// prompt, run it concurrently, and return its final assistant message. Bounded
/// by a lineage depth limit and a process-global concurrency permit; cancelling
/// the parent cancels the child. The child inherits the workspace and policy.
/// The read-only reference block a delegation carries: each handle is resolved
/// against the delegating Session's archive and the whole block is bounded.
async fn reference_block(
    inner: &Arc<Inner>,
    parent: &str,
    references: &[crate::subagent::Reference],
) -> String {
    let mut block = String::new();
    for reference in references {
        let handle = reference.tool_use_id.as_str();
        let resolved = inner
            .store
            .archived_output(parent, handle, reference.offset as usize)
            .await;
        match resolved {
            Ok(value) => match value["text"]
                .as_str()
                .filter(|_| !value["message_seq"].is_null())
            {
                Some(text) => block.push_str(&format!(
                    "--- {handle} window {}:\n{text}\n",
                    reference.offset
                )),
                None => block.push_str(&format!(
                    "--- {handle} window {}: not found in the delegating Session\n",
                    reference.offset
                )),
            },
            Err(_) => block.push_str(&format!(
                "--- {handle} window {}: unavailable\n",
                reference.offset
            )),
        }
    }
    if block.is_empty() {
        return String::new();
    }
    let header = "Referenced material from the delegating Session (read-only; it is not part of your history):\n";
    let room = crate::subagent::REFERENCE_BYTES.saturating_sub(header.len());
    if block.len() > room {
        let mut end = room;
        while end > 0 && !block.is_char_boundary(end) {
            end -= 1;
        }
        return format!("{header}{}[references truncated]\n", &block[..end]);
    }
    format!("{header}{block}")
}

struct Delegation<'a> {
    target: Option<&'a crate::session_agent::AgentManifest>,
    referenced_agents: &'a [crate::session_agent::AgentMention],
    agent: Option<&'a crate::session_agent::AgentManifest>,
    binding: Option<&'a crate::session_model::Binding>,
    account: Option<&'a crate::session_account::Selection>,
    model_override: Option<&'a crate::session_model::Binding>,
    attachments: &'a [Attachment],
    agent_references: &'a [crate::session_agent::AgentManifest],
}

async fn delegate(
    inner: &Arc<Inner>,
    parent: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
    cancel: CancellationToken,
    context: Delegation<'_>,
) -> Result<Value, ToolError> {
    let task = crate::subagent::Input::parse(prepared.input().clone())?;
    let catalog = inner
        .store
        .named_agents(parent)
        .await
        .map_err(|error| ToolError::External(error.to_string()))?;
    let selected = if let Some(target) = context.target {
        if task.agent.as_deref() != Some(&target.name) {
            return Err(ToolError::InvalidInput);
        }
        Some(target.clone())
    } else {
        match &task.agent {
            Some(name) => Some(
                catalog
                    .iter()
                    .find(|agent| &agent.name == name)
                    .cloned()
                    .ok_or_else(|| {
                        ToolError::External(
                            "named subagent was not registered by the trusted host".into(),
                        )
                    })?,
            ),
            None => context.agent.cloned(),
        }
    };
    let model = context.model_override.cloned().or_else(|| {
        if task.agent.is_some() && selected.as_ref().is_some_and(|agent| agent.model.is_some()) {
            None
        } else {
            context.binding.cloned()
        }
    });
    let effective = model
        .as_ref()
        .or_else(|| selected.as_ref().and_then(|agent| agent.model.as_ref()));
    let receipt = match context.account {
        Some(account) => crate::session_account::resolve(
            &inner.provider,
            effective,
            account.credential_id.as_deref(),
        ),
        None => Ok(effective.cloned()),
    }
    .map_err(|error| ToolError::External(error.to_string()))?;
    let provider = crate::session_model::select(&inner.provider, receipt.as_ref())
        .map_err(|error| ToolError::External(error.to_string()))?;
    if let Some(agent) = &selected {
        validate_agent(inner, agent).map_err(|error| ToolError::External(error.to_string()))?;
        if let Some(request) = &agent.request {
            provider
                .with_request_options(request.clone())
                .map_err(|error| ToolError::External(error.to_string()))?;
        }
    }

    let mut depth = 0u32;
    let mut current = parent.to_owned();
    while let Some(ancestor) = inner
        .store
        .lineage_parent(&current)
        .await
        .map_err(|_| ToolError::External("subagent lineage unavailable".into()))?
    {
        depth += 1;
        if depth >= crate::subagent::DEPTH_LIMIT {
            return Err(ToolError::External("subagent depth limit reached".into()));
        }
        current = ancestor;
    }

    let permit = tokio::select! {
        _ = cancel.cancelled() => return Err(ToolError::Interrupted),
        permit = inner.subagent_slots.clone().acquire_owned() => permit
            .map_err(|_| ToolError::External("subagent scheduler unavailable".into()))?,
    };

    let child = task
        .session_id
        .clone()
        .unwrap_or_else(|| format!("{parent}/sub-{}", uuid::Uuid::new_v4()));
    let fork = inner
        .store
        .fork(parent, &child, Some(0))
        .await
        .map_err(|_| ToolError::External("subagent session could not be created".into()))?;
    if fork["duplicate"] != true {
        inner
            .store
            .inherit_delegation_profile(
                &child,
                selected.clone(),
                model,
                context.account.cloned(),
                receipt,
            )
            .await
            .map_err(|error| ToolError::External(error.to_string()))?;
    } else if task.agent.is_some()
        && inner
            .store
            .agent(&child)
            .await
            .map_err(|error| ToolError::External(error.to_string()))?
            .map(|(agent, _)| agent)
            != selected
    {
        return Err(ToolError::External(
            "existing child Session has a different captured agent; adopt its authority explicitly"
                .into(),
        ));
    }
    let description: String = task
        .prompt
        .lines()
        .next()
        .unwrap_or("subagent")
        .chars()
        .take(256)
        .collect();
    inner
        .store
        .record(
            parent,
            crate::events::Lifecycle::SubagentStart.name(),
            json!({"run_id":run,"subagent_id":child,"call_id":call,"background":task.background,
                   "agent":selected.as_ref().map(|agent|agent.name.as_str()).unwrap_or("subagent"),
                   "description":description}),
        )
        .await
        .map_err(|_| ToolError::External("subagent start could not be recorded".into()))?;

    // A child forks empty, so material of the delegating Session reaches it by
    // reference: each handle is resolved here and injected as a bounded window.
    let references = reference_block(inner, parent, &task.references).await;
    let admission = inner
        .store
        .admit_attachments_at(
            Input {
                agent_references: crate::session_agent::AgentReferences {
                    catalog: if context.agent_references.is_empty() {
                        catalog
                    } else {
                        context.agent_references.to_vec()
                    },
                    mentions: context.referenced_agents.to_vec(),
                },
                command: None,
                session_id: child.clone(),
                input_id: format!("{call}:subagent"),
                prompt: format!("{references}{}", task.prompt),
                delivery: crate::protocol::Delivery::Steer,
            },
            context.attachments.to_vec(),
            Some(inner.tools.location().to_owned()),
        )
        .await
        .map_err(|_| ToolError::External("subagent prompt could not be admitted".into()))?;
    wake_session(inner, &child, true)
        .await
        .map_err(|_| ToolError::External("subagent could not be scheduled".into()))?;

    if task.background {
        let background = inner.clone();
        let parent = parent.to_owned();
        let run = run.to_owned();
        let call = call.to_owned();
        let watcher_child = child.clone();
        tokio::spawn(async move {
            if let Err(error) = finish_delegation(
                &background,
                &parent,
                &run,
                &call,
                &watcher_child,
                admission.admitted_seq,
                permit,
                background.stop.clone(),
            )
            .await
            {
                let _ = background
                    .store
                    .record(
                        &parent,
                        crate::events::Lifecycle::SubagentStop.name(),
                        json!({"run_id":run,"subagent_id":watcher_child,"call_id":call,"reason":"failed","text":error.to_string()}),
                    )
                    .await;
            }
        });
        return Ok(json!({"session_id":child,"background":true,"status":"running"}));
    }
    let text = finish_delegation(
        inner,
        parent,
        run,
        call,
        &child,
        admission.admitted_seq,
        permit,
        cancel,
    )
    .await?;
    Ok(json!({"session_id":child,"text":text}))
}

#[allow(clippy::too_many_arguments)]
async fn finish_delegation(
    inner: &Arc<Inner>,
    parent: &str,
    run: &str,
    call: &str,
    child: &str,
    admitted_seq: u64,
    permit: tokio::sync::OwnedSemaphorePermit,
    cancel: CancellationToken,
) -> Result<String, ToolError> {
    let mut reason = "completed";
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = cancel_session(inner, child).await;
                reason = "interrupted";
                break;
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
        let events = inner
            .store
            .events(child, admitted_seq, 500)
            .await
            .map_err(|_| ToolError::External("subagent events unavailable".into()))?;
        if events.iter().any(|event| event.kind == "run.finished") {
            break;
        }
    }
    drop(permit);
    let history = inner
        .store
        .history(child)
        .await
        .map_err(|_| ToolError::External("subagent history unavailable".into()))?;
    let text = history
        .last()
        .and_then(|message| {
            message.content.as_array().and_then(|parts| {
                parts
                    .iter()
                    .find_map(|part| part["text"].as_str())
                    .map(str::to_owned)
            })
        })
        .unwrap_or_default();
    let usage = inner
        .store
        .usage_report(child)
        .await
        .map_err(|_| ToolError::External("subagent usage report unavailable".into()))?;
    inner
        .store
        .record(
            parent,
            crate::events::Lifecycle::SubagentStop.name(),
            json!({"run_id":run,"subagent_id":child,"call_id":call,"reason":reason,
                   "text":text,
                   "tokens":{"input":usage["providerUsage"]["tokens"]["input"].as_u64().unwrap_or(0),"output":usage["providerUsage"]["tokens"]["output"].as_u64().unwrap_or(0)},
                   "usageCoverage":usage["providerUsage"],
                   "turns":usage["turns"]}),
        )
        .await
        .map_err(|_| ToolError::External("subagent stop could not be recorded".into()))?;
    if reason == "interrupted" {
        return Err(ToolError::Interrupted);
    }
    Ok(text)
}

async fn wake_session(inner: &Arc<Inner>, session: &str, force: bool) -> Result<(), Error> {
    let commands = {
        let mut actors = inner.actors.lock().await;
        if inner.stop.is_cancelled() {
            return Err(Error::Closed);
        }
        if let Some(actor) = actors.get(session) {
            actor.commands.clone()
        } else {
            if actors.len() >= 64 {
                return Err(Error::Invalid(
                    "M0 runtime supports at most 64 attached Sessions".into(),
                ));
            }
            let (commands, receive) = mpsc::channel(32);
            let join = tokio::spawn(coordinate(session.to_owned(), inner.clone(), receive));
            actors.insert(
                session.to_owned(),
                Actor {
                    commands: commands.clone(),
                    join,
                },
            );
            commands
        }
    };
    tokio::select! {
        _ = inner.stop.cancelled() => Err(Error::Closed),
        result = commands.send(Command::Wake(force)) => result.map_err(|_| Error::Closed),
    }
}

async fn cancel_session(inner: &Arc<Inner>, session: &str) -> Result<bool, Error> {
    let commands = {
        let actors = inner.actors.lock().await;
        actors.get(session).map(|actor| actor.commands.clone())
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

/// An agent's tool surface: `allow`/`deny` intersect the registered definitions
/// and never add a capability, because permission evaluation still runs per call.
fn agent_tools(
    tools: &Tools,
    agent: Option<&(crate::session_agent::AgentManifest, String)>,
    policy: &Policy,
) -> Vec<crate::protocol::ToolDefinition> {
    tools
        .definitions()
        .into_iter()
        .filter(|tool| {
            agent.is_none_or(|(manifest, _)| manifest.permits(&tool.name))
                && policy.tool_visible(&tool.name)
        })
        .collect()
}

/// Immutable authority chosen at the provider-turn boundary, shared by every
/// call that reply produces. Never rebuilt from a mid-turn agent switch.
struct TurnAuthority<'a> {
    plan: bool,
    policy: &'a Policy,
    agent: Option<&'a crate::session_agent::AgentManifest>,
}

async fn authorize(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: &Prepared,
    cancel: CancellationToken,
    authority: TurnAuthority<'_>,
) -> Result<bool, Error> {
    let TurnAuthority {
        plan,
        policy,
        agent,
    } = authority;
    if agent.is_some_and(|agent| !agent.permits(prepared.name())) {
        inner.store.record(session, crate::events::Lifecycle::PermissionDenied.name(),
            json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"agent_tool_surface","policy_revision":policy.revision()})).await?;
        return Ok(false);
    }
    if plan
        && matches!(
            prepared.access(),
            crate::permission::Access::Write
                | crate::permission::Access::Execute
                | crate::permission::Access::Background
                | crate::permission::Access::Delegate
        )
    {
        inner.store.record(session,crate::events::Lifecycle::PermissionDenied.name(),json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"plan_mode"})).await?;
        return Ok(false);
    }
    let (decision, matcher) = if prepared.targets().is_empty() {
        policy.assess_input(
            prepared.name(),
            prepared.resource(),
            prepared.access(),
            Some(prepared.input()),
        )
    } else {
        prepared
            .targets()
            .iter()
            .map(|target| {
                policy.assess_input(
                    prepared.name(),
                    target,
                    prepared.access(),
                    Some(prepared.input()),
                )
            })
            .reduce(|acc, next| {
                if severity(next.0) > severity(acc.0) {
                    next
                } else {
                    acc
                }
            })
            .expect("a multi-target tool has at least one target")
    };
    match decision {
        Decision::Allow => return Ok(true),
        Decision::Deny => {
            inner.store.record(session,crate::events::Lifecycle::PermissionDenied.name(),json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"policy","policy_revision":policy.revision()})).await?;
            return Ok(false);
        }
        Decision::Ask => {
            let mut auto_targets = prepared.targets().to_vec();
            if auto_targets.is_empty() {
                auto_targets.push(prepared.resource().to_owned());
            }
            if policy.auto_settles(
                prepared.name(),
                prepared.resource(),
                prepared.access(),
                Some(prepared.input()),
                &auto_targets,
            ) {
                inner.store
                    .record(session, "permission.auto_allowed", json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"classifier","policy_revision":policy.revision()}))
                    .await?;
                return Ok(true);
            }
        }
    }
    let input_hash = input_digest(
        inner.tools.location(),
        prepared.name(),
        prepared.resource(),
        prepared.input(),
    )?;
    let authority_revision = crate::permission::digest(&serde_json::to_vec(&json!({
        "semantics":"exact-persistent-authority-v1","policy":policy.revision(),
        "boundary":inner.tools.grant_authority_descriptor(),"access":format!("{:?}",prepared.access()),
    }))?);
    let mut targets = prepared.targets().to_vec();
    if targets.is_empty() {
        targets.push(prepared.resolved_path().to_string_lossy().into_owned());
    }
    let scope = crate::permission_grant::Scope::new(
        inner.tools.location().into(),
        authority_revision,
        prepared.name().into(),
        prepared.resource().into(),
        targets,
        input_hash.clone(),
    )?;
    if inner.store.has_permission_grant(scope.clone()).await? {
        inner.store.record(session,"permission.grant.used",json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"policy_revision":policy.revision()})).await?;
        return Ok(true);
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
        input_hash,
        policy_revision: policy.revision().into(),
        matcher,
        expires_at_ms: now_ms().saturating_add(policy.timeout_ms()),
    };
    inner
        .store
        .request_approval_with_scope(approval.clone(), scope)
        .await?;
    inner.store.record(session,crate::events::Lifecycle::PermissionRequest.name(),json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource()})).await?;
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(policy.timeout_ms());
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
            _ => {
                inner.store.record(session,crate::events::Lifecycle::PermissionDenied.name(),json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"approval_denied"})).await?;
                return Ok(false);
            }
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
                        matcher: None,
                    },
                )
                .await;
            match expired {
                Ok(_) | Err(Error::ApprovalExpired | Error::ApprovalResolved) => {
                    inner.store.record(session,crate::events::Lifecycle::PermissionDenied.name(),json!({"run_id":run,"call_id":call,"tool":prepared.name(),"resource":prepared.resource(),"reason":"approval_expired"})).await?;
                    return Ok(false);
                }
                Err(error) => return Err(error),
            }
        }
        tokio::select! {_=cancel.cancelled()=>return Ok(false),_=tokio::time::sleep(std::time::Duration::from_millis(25))=>{}}
    }
}

/// Wait for a Session-owned job to settle, bounded by the tool contract and
/// the turn's cancellation. A missing job settles immediately, like a finished
/// one: the caller sees `job: null` instead of an error.
async fn wait_background(
    inner: &Inner,
    session: &str,
    wait: &crate::jobs::Wait,
    cancel: CancellationToken,
) -> Result<Value, ToolError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait.timeout_ms);
    loop {
        let job = inner
            .store
            .job(session, &wait.job_id)
            .await
            .map_err(|error| ToolError::External(error.to_string()))?;
        let active = job
            .as_ref()
            .is_some_and(|job| matches!(job["state"].as_str(), Some("queued" | "running")));
        if !active {
            return Ok(json!({"job":job,"timedOut":false}));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(json!({"job":job,"timedOut":true}));
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(ToolError::Interrupted),
            _ = tokio::time::sleep(remaining.min(std::time::Duration::from_millis(50))) => {}
        }
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

/// Admit a background command watch: durable job admission, live stdout
/// filtered by an optional regex, batched notices on the progress channel,
/// hard timeout kills the child. Cancel flows through cancel_job.
async fn start_monitor(
    inner: &Arc<Inner>,
    session: &str,
    run: &str,
    call: &str,
    prepared: Prepared,
) -> Result<Value, ToolError> {
    if inner.stop.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let input = crate::monitor::Input::parse(prepared.input().clone())?;
    let matcher = input.matcher()?;
    let timeout = input.timeout();
    let description = input.description.clone();
    let output_description = description.clone();
    let mut jobs = inner.jobs.lock().await;
    if jobs.len() >= 32 {
        return Err(ToolError::InvalidInput);
    }
    let admission = inner
        .store
        .create_job_for(session, run, call, prepared.input().clone(), "monitor")
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
    let owner = session.to_owned();
    let task_id = id.clone();
    let task_inner = inner.clone();
    let (job_owner, job_token, job_id) = (owner.clone(), token.clone(), id.clone());
    let join = tokio::spawn(async move {
        let (mut group, stdout, _temp) =
            match spawn_sandboxed_monitor(&task_inner, &input, timeout).await {
                Ok(spawned) => spawned,
                Err(error) => {
                    let _ = task_inner
                        .store
                        .record(
                            &owner,
                            "monitor.failed",
                            json!({"job_id":task_id,"message":error.to_string()}),
                        )
                        .await;
                    let _ = finish_background_job(
                        &task_inner,
                        &owner,
                        &task_id,
                        "failed",
                        json!({"error":error.to_string()}),
                    )
                    .await;
                    task_inner.jobs.lock().await.remove(&task_id);
                    return;
                }
            };
        if let Err(error) = task_inner.store.start_job(&owner, &task_id).await {
            let _ = task_inner
                .store
                .record(
                    &owner,
                    "monitor.failed",
                    json!({"job_id":task_id,"message":error.to_string()}),
                )
                .await;
            task_inner.jobs.lock().await.remove(&task_id);
            return;
        }
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        let mut batcher = crate::monitor::Batcher::default();
        let mut window = tokio::time::interval(tokio::time::Duration::from_millis(
            crate::monitor::BATCH_WINDOW_MS,
        ));
        window.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        window.reset();
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_millis(input.timeout());
        let mut stdout_open = true;
        loop {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    group.terminate();
                    let _ = finish_background_job(
                        &task_inner,
                        &owner,
                        &task_id,
                        "cancelled",
                        json!({"reason":"cancelled_by_request"}),
                    )
                    .await;
                    task_inner.jobs.lock().await.remove(&task_id);
                    return;
                }
                _ = tokio::time::sleep_until(deadline) => {
                    group.terminate();
                    let _ = task_inner
                        .store
                        .record(&owner, "monitor.timeout", json!({"job_id":task_id,"timeout_ms":input.timeout()}))
                        .await;
                    if let Some(notice) = batcher.flush(true, &task_id, description.as_deref()) {
                        emit_monitor_notice(&task_inner, &owner, &task_id, notice).await;
                    }
                    let _ = finish_background_job(&task_inner, &owner, &task_id, "failed", json!({"timed_out":true})).await;
                    break;
                }
                _ = window.tick() => {
                    if let Some(notice) = batcher.flush(true, &task_id, description.as_deref()) {
                        emit_monitor_notice(&task_inner, &owner, &task_id, notice).await;
                    }
                }
                line = reader.next_line(), if stdout_open => {
                    match line {
                        Ok(Some(line)) => { batcher.feed(matcher.as_ref(), &line); }
                        // Closing stdout is not process exit. Keep polling
                        // cancellation and timeout while waiting for the child.
                        _ => { stdout_open = false; }
                    }
                }
                // Drain stdout before settling so a short-lived command's last
                // matching lines cannot lose a race against process exit.
                status = group.child.wait(), if !stdout_open => {
                    let code = status.map(|status| status.code().unwrap_or(-1)).unwrap_or(-1);
                    let _ = task_inner.store.record(&owner, "monitor.exited", json!({"job_id":task_id,"code":code})).await;
                    if let Some(notice) = batcher.flush(true, &task_id, description.as_deref()) {
                        emit_monitor_notice(&task_inner, &owner, &task_id, notice).await;
                    }
                    let state = if code == 0 { "completed" } else { "failed" };
                    let _ = finish_background_job(&task_inner, &owner, &task_id, state, json!({"exit_code":code})).await;
                    break;
                }
            }
        }
        group.terminate();
        task_inner.jobs.lock().await.remove(&task_id);
    });
    jobs.insert(
        job_id,
        Background {
            session: job_owner,
            cancel: job_token,
            join,
        },
    );
    Ok(json!({
        "job_id":id,
        "description":output_description,
        "output":"watching stdout; matching lines arrive as monitor.notice progress events; cancel with cancel_job",
        "timeout_ms":timeout,
    }))
}

async fn emit_monitor_notice(inner: &Inner, session: &str, job: &str, notice: Value) {
    let admitted = inner
        .store
        .admit(Input {
            agent_references: Default::default(),
            command: None,
            session_id: session.to_owned(),
            input_id: format!("monitor:{job}:{}", uuid::Uuid::new_v4()),
            prompt: format!("Monitor job {job} produced matching output:\n{notice}"),
            delivery: Delivery::Steer,
        })
        .await;
    let admitted = match admitted {
        Ok(admitted) => admitted,
        Err(error) => {
            let _ = inner
                .store
                .record(
                    session,
                    "monitor.notice_failed",
                    json!({"job_id":job,"message":error.to_string()}),
                )
                .await;
            return;
        }
    };
    let _ = inner.progress.send(notice);
    let _ = notify_admission(
        inner,
        session,
        &admitted,
        "monitor.wake_failed",
        json!({"job_id":job,"input_id":admitted.input_id}),
    )
    .await;
}

/// Launch a monitor command through the same sandboxed runner the process
/// tools use: seatbelt on macOS, Landlock on Linux, AppContainer on Windows.
/// stdout stays piped so the caller can stream matching lines; the minimal
/// environment matches the previous direct spawn.
async fn spawn_sandboxed_monitor(
    inner: &Arc<Inner>,
    input: &crate::monitor::Input,
    timeout_ms: u64,
) -> Result<
    (
        crate::process::Group,
        tokio::process::ChildStdout,
        tempfile::TempDir,
    ),
    ToolError,
> {
    let runner = inner
        .tools
        .process_runner()
        .ok_or(ToolError::Unsupported)?
        .to_owned();
    let workspace = inner.tools.location().to_owned();
    let envs: Vec<(String, String)> = if cfg!(windows) {
        std::env::vars()
            .filter(|(key, _)| {
                matches!(
                    key.to_ascii_uppercase().as_str(),
                    "PATH"
                        | "PATHEXT"
                        | "SYSTEMROOT"
                        | "SYSTEMDRIVE"
                        | "WINDIR"
                        | "COMSPEC"
                        | "USERPROFILE"
                        | "HOMEDRIVE"
                        | "HOMEPATH"
                        | "TEMP"
                        | "TMP"
                )
            })
            .collect()
    } else {
        vec![
            (
                "PATH".into(),
                "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
            ),
            (
                "HOME".into(),
                std::env::var("HOME").unwrap_or_else(|_| "/root".into()),
            ),
            ("LANG".into(), "C.UTF-8".into()),
        ]
    };
    let argv = if cfg!(windows) {
        vec![
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            "/d".into(),
            "/s".into(),
            "/c".into(),
            input.command.clone(),
        ]
    } else {
        vec!["/bin/sh".into(), "-c".into(), input.command.clone()]
    };
    let (mut group, master, temp) = crate::process::spawn(
        std::path::Path::new(&runner),
        std::path::Path::new(&workspace),
        std::path::Path::new(&workspace),
        argv,
        timeout_ms,
        false,
        false,
        inner.tools.process_network_allowed(),
        &envs,
    )
    .await?;
    if master.is_some() {
        return Err(ToolError::Unsupported);
    }
    let stdout = group.child.stdout.take().ok_or(ToolError::Unsupported)?;
    Ok((group, stdout, temp))
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
            Err(_) => {
                finish_background_job(
                    &task_inner,
                    &task_owner,
                    &task_id,
                    "unknown",
                    json!({"error":"job execution task panicked"}),
                )
                .await
            }
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
        finish_background_job(
            &inner,
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
    finish_background_job(&inner, session, id, state, output).await?;
    Ok(())
}

async fn finish_background_job(
    inner: &Inner,
    session: &str,
    id: &str,
    state: &str,
    output: Value,
) -> Result<(), Error> {
    let admitted = inner.store.finish_job(session, id, state, output).await?;
    notify_admission(
        inner,
        session,
        &admitted,
        "job.wake_failed",
        json!({"job_id":id,"input_id":admitted.input_id}),
    )
    .await
}

/// Only a complete, approved, hook-free native read batch can overlap. Mixed
/// tool turns keep their existing barrier semantics and replay stays ordered.
async fn execute_read_batch(
    inner: &Inner,
    session: &str,
    run: &str,
    content: &Value,
    cancel: CancellationToken,
    policy: &Policy,
    agent: Option<&crate::session_agent::AgentManifest>,
) -> Result<HashMap<String, (Value, bool)>, Error> {
    if cancel.is_cancelled()
        || !inner.tools.hooks().is_empty()
        || plugin_marked(inner, "before")
        || plugin_marked(inner, "after")
        || inner.tool_replay.is_some()
    {
        return Ok(HashMap::new());
    }
    let blocks: Vec<&Value> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "tool_use")
        .collect();
    // Mixed-turn partitioning (ADR-13): only the prefix of declared reads
    // before the first non-member batches. A write — or anything the batch
    // cannot admit — ends the prefix, and everything from there settles
    // serially in request order, so a later read never runs ahead of an
    // earlier write.
    let mut prepared = Vec::new();
    for block in blocks {
        let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) else {
            break;
        };
        if block["input_error"].is_string() || block["provider_executed"] == true {
            break;
        }
        let Ok(tool) = inner.tools.prepare(name, block["input"].clone()).await else {
            break;
        };
        // Membership is declaration-driven (ADR-13): a call joins the batch
        // when its own declaration says it only reads a named resource, not
        // because of its name. Anything that declares a write — or anything
        // undeclared — conflicts with the batch and stays serial.
        if agent.is_some_and(|agent| !agent.permits(tool.name()))
            || !tool.batchable_read()
            || tool.access() != crate::permission::Access::Read
            || tool.resource().is_empty()
            || policy
                .assess_input(
                    tool.name(),
                    tool.resource(),
                    tool.access(),
                    Some(tool.input()),
                )
                .0
                != Decision::Allow
        {
            break;
        }
        prepared.push((id.to_owned(), tool));
        if prepared.len() == 16 {
            break;
        }
    }
    if !(2..=16).contains(&prepared.len()) || cancel.is_cancelled() {
        return Ok(HashMap::new());
    }
    inner
        .store
        .record(
            session,
            "tool.parallel.started",
            json!({"run_id":run,"call_ids":prepared.iter().map(|(id,_)| id).collect::<Vec<_>>(),"resources":prepared.iter().map(|(_,tool)| tool.resource()).collect::<Vec<_>>(),"concurrency":4}),
        )
        .await?;
    for (id, tool) in &prepared {
        inner
            .store
            .record(
                session,
                crate::events::Lifecycle::PreToolUse.name(),
                json!({"run_id":run,"call_id":id,"tool":tool.name()}),
            )
            .await?;
        inner.store.mark_dispatched(session, run, id).await?;
    }
    let order: Vec<_> = prepared
        .iter()
        .map(|(id, tool)| (id.clone(), tool.name().to_owned()))
        .collect();
    let mut pending = futures_util::stream::iter(prepared.into_iter().map(|(id, tool)| {
        let cancel = cancel.child_token();
        async move {
            let ask = crate::worker::AskBridge {
                store: &inner.store,
                location: inner.tools.location(),
                session,
                run,
                call: &id,
            };
            let result = inner
                .tools
                .execute_prepared(tool, policy, cancel, Some(&ask))
                .await;
            (id, result)
        }
    }))
    .buffer_unordered(4);
    let mut results = HashMap::new();
    while let Some((id, result)) = pending.next().await {
        let outcome = match result {
            Ok(output) => (output, false),
            Err(error) => (json!({"error":error.to_string()}), true),
        };
        results.insert(id, outcome);
    }
    // Settle every admitted read before the runner can return on cancellation
    // or a repeat limit; projected receipts preserve the provider's call order.
    for (id, name) in order {
        let (output, is_error) = &results[&id];
        inner
            .store
            .tool_result(session, run, &id, output.clone(), *is_error)
            .await?;
        inner
            .store
            .record(
                session,
                crate::events::Lifecycle::PostToolUse.name(),
                json!({"run_id":run,"call_id":id,"tool":name,"is_error":is_error}),
            )
            .await?;
    }
    Ok(results)
}

fn validate_agent(inner: &Inner, agent: &crate::session_agent::AgentManifest) -> Result<(), Error> {
    agent.validate()?;
    inner.policy.for_agent(Some(agent))?;
    if let Some(model) = &agent.model {
        crate::session_model::select(&inner.provider, Some(model))?;
    }
    if let Some(surface) = &agent.tools {
        let known = inner
            .tools
            .definitions()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<std::collections::HashSet<_>>();
        for name in surface.allow.iter().chain(surface.deny.iter()) {
            if !known.contains(name) {
                return Err(Error::Invalid(format!(
                    "agent references an unknown tool: {name}"
                )));
            }
        }
    }

    Ok(())
}
