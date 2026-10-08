use crate::{
    protocol::{Admission, Error, Input, ModelRequest},
    provider::{Provider, ProviderError},
    store::Store,
    tools::{ToolError, Tools},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    provider: Arc<dyn Provider>,
    tools: Tools,
    actors: Mutex<HashMap<String, Actor>>,
    slots: Arc<Semaphore>,
    stop: CancellationToken,
    progress: broadcast::Sender<Value>,
}

struct Actor {
    commands: mpsc::Sender<Command>,
    join: JoinHandle<()>,
}

enum Command {
    Wake(bool),
    Cancel(oneshot::Sender<bool>),
}

impl Runtime {
    pub async fn new(
        store: Store,
        provider: Arc<dyn Provider>,
        tools: Tools,
    ) -> Result<Self, Error> {
        store.recover().await?;
        let (progress, _) = broadcast::channel(256);
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                provider,
                tools,
                actors: Mutex::new(HashMap::new()),
                slots: Arc::new(Semaphore::new(8)),
                stop: CancellationToken::new(),
                progress,
            }),
        })
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
        let admission = self.inner.store.admit(input).await?;
        // An exact retry may repair a lost advisory wake for pending input,
        // but never restarts promoted/completed provider work.
        if resume && admission.pending {
            self.wake(&session, false).await?;
        }
        Ok(admission)
    }

    pub async fn resume(&self, session: &str) -> Result<(), Error> {
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

    pub async fn shutdown(&self) {
        self.inner.stop.cancel();
        let actors = std::mem::take(&mut *self.inner.actors.lock().await);
        for (_, actor) in actors {
            let _ = actor.join.await;
        }
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
    inner: &Inner,
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
        inner
            .store
            .record(
                session,
                "provider.started",
                json!({"run_id":run,"step":step}),
            )
            .await?;
        let history = inner.store.history(session).await?;
        let (send, mut receive) = mpsc::channel(64);
        let response = inner.provider.stream(
            ModelRequest {
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
                        json!({"run_id":run,"step":step,"message":error.to_string()}),
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
                let (output, is_error) = match inner
                    .tools
                    .execute(name, block["input"].clone(), cancel.child_token())
                    .await
                {
                    Ok(output) => (output, false),
                    Err(ToolError::Interrupted) => return Ok(()),
                    Err(error) => (json!({"error":error.to_string()}), true),
                };
                let signature = serde_json::to_string(
                    &json!({"name":name,"input":block["input"],"output":output,"is_error":is_error}),
                )?;
                inner
                    .store
                    .tool_result(session, run, id, output, is_error)
                    .await?;
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
