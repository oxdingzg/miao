use crate::{
    approval::{now_ms, Approval, Response},
    permission::{input_digest, Decision},
    protocol::{Admission, Delivery, Error, Event, Input, Message},
};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{mpsc, oneshot};

type Work = Box<dyn FnOnce(&mut Connection) + Send>;

/// One dedicated SQLite worker owns both the connection and store lease. Async
/// callers never block a Tokio worker on SQLite locks or filesystem operations.
#[derive(Clone)]
pub struct Store {
    work: mpsc::Sender<Work>,
    runtime_owner: Arc<AtomicBool>,
    path: Arc<std::path::PathBuf>,
}

pub(crate) struct RuntimeLease {
    owner: Arc<AtomicBool>,
}
impl Drop for RuntimeLease {
    fn drop(&mut self) {
        self.owner.store(false, Ordering::Release);
    }
}

impl Store {
    pub(crate) fn claim_runtime(&self) -> Result<RuntimeLease, Error> {
        self.runtime_owner
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Error::Busy)?;
        Ok(RuntimeLease {
            owner: self.runtime_owner.clone(),
        })
    }

    pub async fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref().to_path_buf();
        let (work, mut receive) = mpsc::channel::<Work>(64);
        let (ready, started) = oneshot::channel();
        std::thread::spawn(move || {
            let opened = (|| -> Result<_, Error> {
                if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                    std::fs::create_dir_all(parent)?;
                }
                // Canonicalize the DB itself when present (including symlinks),
                // otherwise its parent; aliases must contend for the same lease.
                let canonical = if path.exists() {
                    path.canonicalize()?
                } else {
                    let parent = path
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .unwrap_or(Path::new("."));
                    parent.canonicalize()?.join(
                        path.file_name()
                            .ok_or_else(|| Error::Invalid("store path".into()))?,
                    )
                };
                let lease = OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(canonical.with_extension("engine-lock"))?;
                lease.try_lock_exclusive().map_err(|e| {
                    if e.kind() == std::io::ErrorKind::WouldBlock {
                        Error::Busy
                    } else {
                        Error::Io(e)
                    }
                })?;
                let conn = Connection::open(&canonical)?;
                let app_id: u32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
                let engine:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='engine_session' AND type='table')",[],|r|r.get(0))?;
                let existing:u32=conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|r|r.get(0))?;
                if (app_id != 0 && app_id != 0x4d494145) || (!engine && existing != 0) {
                    return Err(Error::Invalid(
                        "not a miao-engine database; use a separate path".into(),
                    ));
                }
                let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
                if version > 2 {
                    return Err(Error::Invalid("unsupported database schema version".into()));
                }

                conn.execute_batch("PRAGMA application_id=1296646469; PRAGMA user_version=2; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                    CREATE TABLE IF NOT EXISTS engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE IF NOT EXISTS engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_message(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), state TEXT NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS engine_active_run ON engine_run(session_id) WHERE state='running';
                    CREATE TABLE IF NOT EXISTS engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_run(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_location(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),root TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_approval(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),run_id TEXT NOT NULL REFERENCES engine_run(id),call_id TEXT NOT NULL REFERENCES engine_tool(id),binding TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS engine_pending_approval ON engine_approval(call_id) WHERE state='pending';")?;
                Ok((conn, lease, canonical))
            })();
            match opened {
                Ok((mut conn, _lease, canonical)) => {
                    if ready.send(Ok(canonical)).is_err() {
                        return;
                    }
                    while let Some(job) = receive.blocking_recv() {
                        job(&mut conn);
                    }
                }
                Err(error) => {
                    let _ = ready.send(Err(error));
                }
            }
        });
        let path = started.await.map_err(|_| Error::Closed)??;
        Ok(Self {
            work,
            runtime_owner: Arc::new(AtomicBool::new(false)),
            path: Arc::new(path),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let (send, receive) = oneshot::channel();
        self.work
            .send(Box::new(move |conn| {
                let _ = send.send(f(conn));
            }))
            .await
            .map_err(|_| Error::Closed)?;
        receive.await.map_err(|_| Error::Closed)?
    }

    /// Committed before acknowledgement. Duplicate IDs reconcile the entire
    /// admission, never just its prompt text; a lost ack cannot duplicate work.
    pub async fn admit(&self, input: Input) -> Result<Admission, Error> {
        self.admit_at(input, None).await
    }

    pub async fn admit_at(&self, input: Input, root: Option<String>) -> Result<Admission, Error> {
        if input.session_id.is_empty() || input.input_id.is_empty() || input.prompt.is_empty() {
            return Err(Error::Invalid(
                "session_id, input_id and prompt must be nonempty".into(),
            ));
        }
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let existing:Option<(String,String,String,u64,String)>=tx.query_row("SELECT session_id,prompt,delivery,admitted_seq,state FROM engine_input WHERE id=?1",[&input.input_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let delivery=match input.delivery {Delivery::Steer=>"steer",Delivery::Queue=>"queue"};
            if let Some((session,prompt,mode,_,_))=&existing {
                if session!=&input.session_id||prompt!=&input.prompt||mode!=delivery {return Err(Error::Conflict);}
            }
            tx.execute("INSERT OR IGNORE INTO engine_session(id) VALUES(?1)",[&input.session_id])?;
            if let Some(root)=root {
                let placement:Option<String>=tx.query_row("SELECT root FROM engine_location WHERE session_id=?1",[&input.session_id],|r|r.get(0)).optional()?;
                if placement.is_some_and(|r|r!=root) {return Err(Error::Conflict);}
                tx.execute("INSERT OR IGNORE INTO engine_location VALUES(?1,?2)",params![input.session_id,root])?;
            }
            if let Some((_,_,_,seq,state))=existing {
                tx.commit()?;
                return Ok(Admission{input_id:input.input_id,admitted_seq:seq,duplicate:true,pending:state=="pending"});
            }
            let event=append(&tx,&input.session_id,"input.admitted",json!({"input_id":input.input_id,"delivery":delivery}))?;
            tx.execute("INSERT INTO engine_input VALUES(?1,?2,?3,?4,'pending',?5)",params![input.input_id,input.session_id,input.prompt,delivery,event.seq])?;
            tx.commit()?;
            Ok(Admission{input_id:input.input_id,admitted_seq:event.seq,duplicate:false,pending:true})
        }).await
    }

    pub async fn location(&self, session: &str) -> Result<Option<String>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT root FROM engine_location WHERE session_id=?1",
                    [session],
                    |r| r.get(0),
                )
                .optional()?)
        })
        .await
    }

    /// Safe-boundary promotion: all steers first, then one queued item only when
    /// idle. Projection and promotion events share the same transaction.
    pub async fn promote(&self, session: &str, idle: bool) -> Result<Vec<Event>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let mut pending: Vec<(String, String)> = {
                let mut stmt = tx.prepare("SELECT id,prompt FROM engine_input WHERE session_id=?1 AND state='pending' AND delivery='steer' ORDER BY admitted_seq")?;
                let rows = stmt.query_map([&session], |r| Ok((r.get(0)?,r.get(1)?)))?;
                rows.collect::<Result<_,_>>()?
            };
            if pending.is_empty() && idle {
                if let Some(row) = tx.query_row("SELECT id,prompt FROM engine_input WHERE session_id=?1 AND state='pending' AND delivery='queue' ORDER BY admitted_seq LIMIT 1", [&session], |r| Ok((r.get(0)?,r.get(1)?))).optional()? { pending.push(row); }
            }
            let mut events = Vec::new();
            for (id,prompt) in pending {
                let e = append(&tx, &session, "input.promoted", json!({"input_id":id,"prompt":prompt}))?;
                tx.execute("UPDATE engine_input SET state='promoted' WHERE id=?1", [&id])?;
                tx.execute("INSERT INTO engine_message VALUES(?1,?2,'user',?3)", params![session,e.seq,serde_json::to_string(&json!([{"type":"text","text":prompt}]))?])?;
                events.push(e);
            }
            tx.commit()?;
            Ok(events)
        }).await
    }

    pub async fn history(&self, session: &str) -> Result<Vec<Message>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT role,content FROM engine_message WHERE session_id=?1 ORDER BY seq",
            )?;
            let rows = stmt.query_map([session], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            rows.map(|row| {
                let (role, content) = row?;
                Ok(Message {
                    role,
                    content: serde_json::from_str(&content)?,
                })
            })
            .collect()
        })
        .await
    }

    pub async fn events(&self, session: &str, after: u64, limit: u32) -> Result<Vec<Event>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare("SELECT seq,kind,data FROM engine_event WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
            let rows = stmt.query_map(params![session,after,limit.min(1000)], |r| Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?;
            rows.map(|row| { let (seq,kind,data) = row?; Ok(Event { session_id:session.clone(),seq,kind,data:serde_json::from_str(&data)? }) }).collect()
        }).await
    }

    pub async fn start_run(&self, session: &str, run: &str) -> Result<Event, Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO engine_run VALUES(?1,?2,'running')",
                params![run, session],
            )?;
            let e = append(&tx, &session, "run.started", json!({"run_id":run}))?;
            tx.commit()?;
            Ok(e)
        })
        .await
    }

    pub async fn message(&self, session: &str, role: &str, content: Value) -> Result<Event, Error> {
        let (session, role) = (session.to_owned(), role.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let e = append(
                &tx,
                &session,
                "message.committed",
                json!({"role":role,"content":content}),
            )?;
            tx.execute(
                "INSERT INTO engine_message VALUES(?1,?2,?3,?4)",
                params![session, e.seq, role, serde_json::to_string(&content)?],
            )?;
            tx.commit()?;
            Ok(e)
        })
        .await
    }

    pub async fn tool_dispatch(
        &self,
        session: &str,
        run: &str,
        id: &str,
        name: &str,
        input: Value,
    ) -> Result<Event, Error> {
        let (session, run, id, name) = (
            session.to_owned(),
            run.to_owned(),
            id.to_owned(),
            name.to_owned(),
        );
        self.call(move |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO engine_tool VALUES(?1,?2,?3,?4,'dispatched')",
                params![id, run, name, serde_json::to_string(&input)?],
            )?;
            let e = append(
                &tx,
                &session,
                "tool.dispatched",
                json!({"run_id":run,"call_id":id,"name":name,"input":input}),
            )?;
            tx.commit()?;
            Ok(e)
        })
        .await
    }

    pub async fn tool_settle(
        &self,
        session: &str,
        id: &str,
        result: Value,
    ) -> Result<Event, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let changed = tx.execute("UPDATE engine_tool SET state='completed' WHERE id=?1 AND state='dispatched' AND run_id IN (SELECT id FROM engine_run WHERE session_id=?2 AND state='running')",params![id,session])?;
            if changed != 1 { return Err(Error::Invalid("tool call is not dispatchable".into())); }
            let e = append(&tx,&session,"tool.completed",json!({"call_id":id,"result":result}))?;
            tx.commit()?;
            Ok(e)
        }).await
    }

    pub async fn record(&self, session: &str, kind: &str, data: Value) -> Result<Event, Error> {
        let (session, kind) = (session.to_owned(), kind.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let event = append(&tx, &session, &kind, data)?;
            tx.commit()?;
            Ok(event)
        })
        .await
    }

    /// Assistant projection and every tool dispatch intent commit together.
    /// The opaque engine key is scoped by run; provider IDs remain in history.
    pub async fn assistant_reply(
        &self,
        session: &str,
        run: &str,
        content: Value,
    ) -> Result<Event, Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE id=?1 AND session_id=?2 AND state='running')",params![run,session],|r|r.get(0))?;
            if !active { return Err(Error::Invalid("run is not active".into())); }
            for block in content.as_array().ok_or_else(||Error::Invalid("assistant content".into()))? {
                if block["type"]!="tool_use" { continue; }
                let id=block["id"].as_str().filter(|s|!s.is_empty()).ok_or_else(||Error::Invalid("tool id".into()))?;
                let name=block["name"].as_str().ok_or_else(||Error::Invalid("tool name".into()))?;
                let key=format!("{run}/{id}");
                tx.execute("INSERT INTO engine_tool VALUES(?1,?2,?3,?4,'planned')",params![key,run,name,serde_json::to_string(&json!({"provider_id":id,"input":block["input"]}))?])?;
                append(&tx,&session,"tool.planned",json!({"run_id":run,"call_id":key,"provider_id":id,"name":name}))?;
            }
            let event=project_message(&tx,&session,"assistant",content)?;
            tx.commit()?;
            Ok(event)
        }).await
    }

    pub async fn tool_result(
        &self,
        session: &str,
        run: &str,
        provider_id: &str,
        result: Value,
        is_error: bool,
    ) -> Result<Event, Error> {
        let (session, run, id) = (session.to_owned(), run.to_owned(), provider_id.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let key=format!("{run}/{id}");
            let changed=tx.execute("UPDATE engine_tool SET state='completed' WHERE id=?1 AND state IN ('planned','dispatched') AND run_id IN (SELECT id FROM engine_run WHERE id=?2 AND session_id=?3 AND state='running')",params![key,run,session])?;
            if changed!=1 { return Err(Error::Invalid("tool is not dispatched".into())); }
            append(&tx,&session,"tool.completed",json!({"call_id":key,"result":result,"is_error":is_error}))?;
            let event=project_message(&tx,&session,"user",json!([{"type":"tool_result","tool_use_id":id,"content":serde_json::to_string(&result)?,"is_error":is_error}]))?;
            tx.commit()?;
            Ok(event)
        }).await
    }

    pub async fn mark_dispatched(
        &self,
        session: &str,
        run: &str,
        provider_id: &str,
    ) -> Result<Event, Error> {
        let (session, run, id) = (session.to_owned(), run.to_owned(), provider_id.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let key=format!("{run}/{id}");
            let count=tx.execute("UPDATE engine_tool SET state='dispatched' WHERE id=?1 AND state='planned' AND run_id IN (SELECT id FROM engine_run WHERE id=?2 AND session_id=?3 AND state='running')",params![key,run,session])?;
            if count!=1 {return Err(Error::Invalid("tool is not planned".into()));}
            let event=append(&tx,&session,"tool.dispatched",json!({"run_id":run,"call_id":key,"provider_id":id}))?;
            tx.commit()?;Ok(event)
        }).await
    }

    pub async fn request_approval(&self, approval: Approval) -> Result<Event, Error> {
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let key=format!("{}/{}",approval.run_id,approval.call_id);
            let row:Option<(String,String,String)>=tx.query_row("SELECT t.name,t.input,l.root FROM engine_tool t JOIN engine_run r ON r.id=t.run_id JOIN engine_location l ON l.session_id=r.session_id WHERE t.id=?1 AND t.state='planned' AND r.id=?2 AND r.session_id=?3 AND r.state='running'",params![key,approval.run_id,approval.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (name,input,root)=row.ok_or(Error::ApprovalResolved)?;
            let original:Value=serde_json::from_str(&input)?;
            if name!=approval.tool||root!=approval.location||original["input"]!=approval.input||input_digest(&root,&name,&approval.resource,&approval.input)?!=approval.input_hash {return Err(Error::ApprovalMismatch);}
            if approval.expires_at_ms<=now_ms(){return Err(Error::ApprovalExpired);}
            tx.execute("INSERT INTO engine_approval VALUES(?1,?2,?3,?4,?5,?6,'pending')",params![approval.request_id,approval.session_id,approval.run_id,key,serde_json::to_string(&approval)?,approval.expires_at_ms])?;
            let event=append(&tx,&approval.session_id,"approval.requested",serde_json::to_value(&approval)?)?;
            tx.commit()?;Ok(event)
        }).await
    }

    pub async fn resolve_approval(
        &self,
        session: &str,
        response: Response,
    ) -> Result<Event, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let row:Option<(String,String,bool)>=tx.query_row("SELECT a.binding,a.state,r.state='running' FROM engine_approval a JOIN engine_run r ON r.id=a.run_id WHERE a.id=?1 AND a.session_id=?2",params![response.request_id,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let (binding,state,active)=row.ok_or(Error::ApprovalResolved)?;
            if state!="pending"||!active {return Err(Error::ApprovalResolved);}
            let approval:Approval=serde_json::from_str(&binding)?;
            if response.input_hash!=approval.input_hash||response.policy_revision!=approval.policy_revision||response.decision==Decision::Ask {return Err(Error::ApprovalMismatch);}
            let state=if approval.expires_at_ms<=now_ms(){"expired"}else if response.decision==Decision::Allow{"allow"}else{"deny"};
            tx.execute("UPDATE engine_approval SET state=?2 WHERE id=?1",params![response.request_id,state])?;
            let event=append(&tx,&session,"approval.resolved",json!({"request_id":response.request_id,"state":state}))?;
            tx.commit()?;
            if state=="expired" {return Err(Error::ApprovalExpired);}
            Ok(event)
        }).await
    }

    pub async fn approval_state(&self, id: &str) -> Result<String, Error> {
        let id = id.to_owned();
        self.call(move |conn| {
            Ok(
                conn.query_row("SELECT state FROM engine_approval WHERE id=?1", [id], |r| {
                    r.get(0)
                })?,
            )
        })
        .await
    }

    pub async fn finish_run(&self, session: &str, run: &str, reason: &str) -> Result<Event, Error> {
        let (session, run, reason) = (session.to_owned(), run.to_owned(), reason.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let changed = tx.execute(
                "UPDATE engine_run SET state=?3 WHERE id=?1 AND session_id=?2 AND state='running'",
                params![run, session, reason],
            )?;
            if changed != 1 {
                return Err(Error::Invalid("run is not active".into()));
            }
            reconcile_tools(&tx, &session, &run)?;
            // An interrupted dispatched tool is unknown, not retryable.
            tx.execute(
                "UPDATE engine_tool SET state='unknown' WHERE run_id=?1 AND state='dispatched'",
                [&run],
            )?;
            let e = append(
                &tx,
                &session,
                "run.finished",
                json!({"run_id":run,"reason":reason}),
            )?;
            tx.commit()?;
            Ok(e)
        })
        .await
    }

    /// Startup reconciliation never resumes provider work or repeats tools.
    pub async fn recover(&self) -> Result<Vec<Event>, Error> {
        self.recover_session(None).await
    }

    pub async fn recover_session(&self, session: Option<&str>) -> Result<Vec<Event>, Error> {
        let session = session.map(str::to_owned);
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let runs: Vec<(String, String)> = {
                let mut stmt =
                    tx.prepare("SELECT id,session_id FROM engine_run WHERE state='running' AND (?1 IS NULL OR session_id=?1)")?;
                let rows = stmt.query_map([session], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<Result<_, _>>()?
            };
            let mut events = Vec::new();
            for (run, session) in runs {
                reconcile_tools(&tx, &session, &run)?;
                tx.execute(
                    "UPDATE engine_tool SET state='unknown' WHERE run_id=?1 AND state='dispatched'",
                    [&run],
                )?;
                tx.execute(
                    "UPDATE engine_run SET state='interrupted' WHERE id=?1",
                    [&run],
                )?;
                events.push(append(
                    &tx,
                    &session,
                    "run.finished",
                    json!({"run_id":run,"reason":"interrupted","recovered":true}),
                )?);
            }
            tx.commit()?;
            Ok(events)
        })
        .await
    }
}

fn append(tx: &Transaction<'_>, session: &str, kind: &str, data: Value) -> Result<Event, Error> {
    let seq: u64 = tx.query_row(
        "UPDATE engine_session SET next_seq=next_seq+1 WHERE id=?1 RETURNING next_seq",
        [session],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO engine_event VALUES(?1,?2,?3,?4)",
        params![session, seq, kind, serde_json::to_string(&data)?],
    )?;
    Ok(Event {
        session_id: session.into(),
        seq,
        kind: kind.into(),
        data,
    })
}

fn project_message(
    tx: &Transaction<'_>,
    session: &str,
    role: &str,
    content: Value,
) -> Result<Event, Error> {
    let event = append(
        tx,
        session,
        "message.committed",
        json!({"role":role,"content":content}),
    )?;
    tx.execute(
        "INSERT INTO engine_message VALUES(?1,?2,?3,?4)",
        params![session, event.seq, role, serde_json::to_string(&content)?],
    )?;
    Ok(event)
}

fn reconcile_tools(tx: &Transaction<'_>, session: &str, run: &str) -> Result<(), Error> {
    let inputs: Vec<(String, String)> = {
        let mut stmt=tx.prepare("SELECT input,state FROM engine_tool WHERE run_id=?1 AND state IN ('planned','dispatched')")?;
        let rows = stmt.query_map([run], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut results = Vec::new();
    for (input, state) in inputs {
        let data: Value = serde_json::from_str(&input)?;
        if let Some(id) = data["provider_id"].as_str() {
            let reason = if state == "planned" {
                "Execution stopped before dispatch; no tool operation was started."
            } else {
                "Execution interrupted; outcome unknown. Do not automatically repeat side effects."
            };
            results.push(
                json!({"type":"tool_result","tool_use_id":id,"content":reason,"is_error":true}),
            );
        }
    }
    if !results.is_empty() {
        project_message(tx, session, "user", Value::Array(results))?;
    }
    tx.execute(
        "UPDATE engine_tool SET state='not_executed' WHERE run_id=?1 AND state='planned'",
        [run],
    )?;
    let approvals: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT id FROM engine_approval WHERE run_id=?1 AND state='pending'")?;
        let rows = stmt.query_map([run], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in approvals {
        tx.execute(
            "UPDATE engine_approval SET state='cancelled' WHERE id=?1",
            [&id],
        )?;
        append(
            tx,
            session,
            "approval.resolved",
            json!({"request_id":id,"state":"cancelled"}),
        )?;
    }
    Ok(())
}
