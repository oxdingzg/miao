use crate::{
    approval::{now_ms, Approval, Response},
    permission::{context_digest, input_digest, Decision},
    protocol::{
        Admission, Attachment, CollaborationMode, ContextBundle, Delivery, Error, Event, Input,
        Message,
    },
};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::sync::{mpsc, oneshot, watch};

pub(crate) const APPLICATION_ID: u32 = 0x4d494145;
pub(crate) const SCHEMA_VERSION: u32 = 11;

type Work = Box<dyn FnOnce(&mut Connection) + Send>;

/// A durable, fenced claim on one Session's execution. Every claim advances
/// `epoch`, so a writer whose ownership was superseded is rejected even while
/// it is still running. This is the fence later cross-process ownership uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLease {
    pub session: String,
    pub epoch: u64,
}

/// In-process guard on the set of locked store paths. The OS file lock provides
/// the cross-process guarantee; this additionally rejects a second open in the
/// same process on platforms whose file locks do not (for example Windows), and
/// fails fast without touching the database.
fn locked_paths() -> &'static Mutex<HashSet<PathBuf>> {
    static LOCKED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    LOCKED.get_or_init(|| Mutex::new(HashSet::new()))
}

struct FileLease {
    path: PathBuf,
    _file: File,
}
impl Drop for FileLease {
    fn drop(&mut self) {
        if let Ok(mut locked) = locked_paths().lock() {
            locked.remove(&self.path);
        }
    }
}

/// One dedicated SQLite worker owns both the connection and store lease. Async
/// callers never block a Tokio worker on SQLite locks or filesystem operations.
#[derive(Clone)]
pub struct Store {
    work: mpsc::Sender<Work>,
    closed: watch::Receiver<()>,
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
        let (stopped, closed) = watch::channel(());
        std::thread::spawn(move || {
            // Dropped after the worker connection and file lease, including on panic.
            let _stopped = stopped;
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
                // In-process ownership is checked first: it is authoritative for
                // same-process opens and does not depend on platform lock
                // semantics. The OS lock then provides the cross-process lease.
                if !locked_paths()
                    .lock()
                    .map_err(|_| Error::Busy)?
                    .insert(canonical.clone())
                {
                    return Err(Error::Busy);
                }
                let file = match OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(canonical.with_extension("engine-lock"))
                {
                    Ok(file) => file,
                    Err(error) => {
                        if let Ok(mut locked) = locked_paths().lock() {
                            locked.remove(&canonical);
                        }
                        return Err(Error::Io(error));
                    }
                };
                // Any failure here means another process holds the lease. Windows
                // reports lock contention as a lock-violation error, not
                // `WouldBlock`, so treat every failure as `Busy`.
                if file.try_lock_exclusive().is_err() {
                    if let Ok(mut locked) = locked_paths().lock() {
                        locked.remove(&canonical);
                    }
                    return Err(Error::Busy);
                }
                let lease = FileLease {
                    path: canonical.clone(),
                    _file: file,
                };
                let conn = Connection::open(&canonical)?;
                let app_id: u32 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
                let engine:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='engine_session' AND type='table')",[],|r|r.get(0))?;
                let existing:u32=conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|r|r.get(0))?;
                if (app_id != 0 && app_id != APPLICATION_ID) || (!engine && existing != 0) {
                    return Err(Error::Invalid(
                        "not a miao-engine database; use a separate path".into(),
                    ));
                }
                let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
                if version > SCHEMA_VERSION {
                    return Err(Error::Invalid("unsupported database schema version".into()));
                }

                conn.execute_batch(&format!("PRAGMA application_id={APPLICATION_ID}; PRAGMA user_version={SCHEMA_VERSION}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                    CREATE TABLE IF NOT EXISTS engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'build');
                    CREATE TABLE IF NOT EXISTS engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_message(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, checkpoint TEXT, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), state TEXT NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS engine_active_run ON engine_run(session_id) WHERE state='running';
                    CREATE TABLE IF NOT EXISTS engine_timing(session_id TEXT NOT NULL REFERENCES engine_session(id), run_id TEXT NOT NULL, step INTEGER NOT NULL, ttft_ms INTEGER NOT NULL, PRIMARY KEY(session_id,run_id,step));
                    CREATE TABLE IF NOT EXISTS engine_cache_prefix(session_id TEXT PRIMARY KEY REFERENCES engine_session(id), affinity_session TEXT NOT NULL, route_hash TEXT NOT NULL, parameters_hash TEXT NOT NULL, history_hash TEXT NOT NULL, message_count INTEGER NOT NULL, session_seq INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_run(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_location(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),root TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_approval(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),run_id TEXT NOT NULL REFERENCES engine_run(id),call_id TEXT NOT NULL REFERENCES engine_tool(id),binding TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS engine_pending_approval ON engine_approval(call_id) WHERE state='pending';
                    CREATE TABLE IF NOT EXISTS engine_lineage(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),parent_session_id TEXT NOT NULL REFERENCES engine_session(id),message_seq INTEGER NOT NULL);
                    CREATE INDEX IF NOT EXISTS engine_pending_inputs ON engine_input(session_id,state,admitted_seq);
                    CREATE TABLE IF NOT EXISTS engine_context(session_id TEXT NOT NULL REFERENCES engine_session(id),epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,system TEXT NOT NULL,sources TEXT NOT NULL,selected_seq INTEGER NOT NULL,PRIMARY KEY(session_id,epoch));
                    CREATE TABLE IF NOT EXISTS engine_job(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),request_key TEXT UNIQUE NOT NULL REFERENCES engine_tool(id),state TEXT NOT NULL,input TEXT NOT NULL,result TEXT);
                    CREATE TABLE IF NOT EXISTS engine_compaction(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),through_seq INTEGER NOT NULL,summary TEXT NOT NULL,created_seq INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS engine_lease(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),interval_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,epoch INTEGER NOT NULL);"))?;
                let has_mode:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_session') WHERE name='mode')",[],|r|r.get(0))?;
                if !has_mode {
                    conn.execute(
                        "ALTER TABLE engine_session ADD COLUMN mode TEXT NOT NULL DEFAULT 'build'",
                        [],
                    )?;
                }
                let has_title:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_session') WHERE name='title')",[],|r|r.get(0))?;
                if !has_title {
                    conn.execute(
                        "ALTER TABLE engine_session ADD COLUMN title TEXT NOT NULL DEFAULT ''",
                        [],
                    )?;
                }
                // Nullable on purpose: sessions that predate the columns keep an
                // unknown creation/update time instead of a fabricated one.
                for column in ["created_at_ms", "updated_at_ms"] {
                    let has_time:bool=conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_session') WHERE name=?1)",
                        [column],|r|r.get(0))?;
                    if !has_time {
                        conn.execute(
                            &format!("ALTER TABLE engine_session ADD COLUMN {column} INTEGER"),
                            [],
                        )?;
                    }
                }
                let has_turn_ms:bool=conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_timing') WHERE name='turn_ms')",
                    [],|r|r.get(0))?;
                if !has_turn_ms {
                    conn.execute("ALTER TABLE engine_timing ADD COLUMN turn_ms INTEGER", [])?;
                }
                let has_checkpoint:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_message') WHERE name='checkpoint')",[],|r|r.get(0))?;
                if !has_checkpoint {
                    conn.execute("ALTER TABLE engine_message ADD COLUMN checkpoint TEXT", [])?;
                }
                let has_attachments:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_input') WHERE name='attachments')",[],|r|r.get(0))?;
                if !has_attachments {
                    conn.execute("ALTER TABLE engine_input ADD COLUMN attachments TEXT", [])?;
                }
                let has_reverted:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('engine_message') WHERE name='reverted')",[],|r|r.get(0))?;
                if !has_reverted {
                    conn.execute(
                        "ALTER TABLE engine_message ADD COLUMN reverted INTEGER NOT NULL DEFAULT 0",
                        [],
                    )?;
                }
                // Nullable migration deliberately leaves historical times unknown.
                for table in ["engine_event", "engine_message"] {
                    let has_time: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='recorded_at_ms')",
                        [table], |row| row.get(0),
                    )?;
                    if !has_time {
                        conn.execute(
                            &format!("ALTER TABLE {table} ADD COLUMN recorded_at_ms INTEGER"),
                            [],
                        )?;
                    }
                }
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
            closed,
            runtime_owner: Arc::new(AtomicBool::new(false)),
            path: Arc::new(path),
        })
    }

    /// Close the last Store handle and wait for SQLite and the file lease to
    /// finish teardown. Dropping a Store only starts asynchronous worker exit.
    /// A live clone (including a Runtime) must be released before calling this.
    pub async fn close(self) -> Result<(), Error> {
        if self.work.strong_count() != 1 {
            return Err(Error::Busy);
        }
        let Self {
            work, mut closed, ..
        } = self;
        drop(work);
        let _ = closed.changed().await;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) async fn call<T: Send + 'static>(
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

    /// Admit a prompt together with bounded inline media attachments. The
    /// attachments are part of the admission identity: a retry with different
    /// media conflicts instead of silently changing the committed prompt.
    pub async fn admit_with(
        &self,
        input: Input,
        attachments: Vec<Attachment>,
    ) -> Result<Admission, Error> {
        self.admit_attachments_at(input, attachments, None).await
    }

    pub async fn admit_at(&self, input: Input, root: Option<String>) -> Result<Admission, Error> {
        self.admit_attachments_at(input, Vec::new(), root).await
    }

    pub async fn admit_attachments_at(
        &self,
        input: Input,
        attachments: Vec<Attachment>,
        root: Option<String>,
    ) -> Result<Admission, Error> {
        if attachments.len() > 8 {
            return Err(Error::Invalid("attachment count limit".into()));
        }
        for attachment in &attachments {
            attachment.validate()?;
        }
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let admission = admit_input(&tx, &input, root.as_deref(), &attachments)?;
            tx.commit()?;
            Ok(admission)
        })
        .await
    }

    pub async fn active_run(&self, session: &str) -> Result<Option<String>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT id FROM engine_run WHERE session_id=?1 AND state='running'",
                    [&session],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await
    }

    /// Initialize identity and location without an inbox row. Retries preserve
    /// title edits and timestamps; another location cannot adopt the identity.
    pub async fn initialize(&self, session: &str, title: &str, root: &str) -> Result<Value, Error> {
        if session.is_empty() || title.len() > 1024 {
            return Err(Error::Invalid("invalid Session identity or title".into()));
        }
        let (session, title, root) = (session.to_owned(), title.to_owned(), root.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",
                [&session], |row| row.get(0),
            )?;
            if exists {
                let existing: Option<String> = tx.query_row(
                    "SELECT root FROM engine_location WHERE session_id=?1",
                    [&session], |row| row.get(0),
                ).optional()?;
                if existing.as_deref() != Some(root.as_str()) {
                    return Err(Error::Conflict);
                }
                return Ok(json!({"session_id":session,"duplicate":true}));
            }
            let now = crate::approval::now_ms() as i64;
            tx.execute(
                "INSERT INTO engine_session(id,next_seq,title,created_at_ms,updated_at_ms) VALUES(?1,0,?2,?3,?3)",
                params![session,title,now],
            )?;
            tx.execute("INSERT INTO engine_location(session_id,root) VALUES(?1,?2)", params![session,root])?;
            append(&tx, &session, "session.initialized", json!({"title":title,"location":root}))?;
            tx.commit()?;
            Ok(json!({"session_id":session,"duplicate":false}))
        }).await
    }

    /// The Session's collaboration mode. A Session without a row defaults to
    /// Build, matching the schema default.
    pub async fn mode(&self, session: &str) -> Result<CollaborationMode, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mode: Option<String> = conn
                .query_row(
                    "SELECT mode FROM engine_session WHERE id=?1",
                    [&session],
                    |r| r.get(0),
                )
                .optional()?;
            match mode.as_deref() {
                None | Some("build") => Ok(CollaborationMode::Build),
                Some("plan") => Ok(CollaborationMode::Plan),
                Some(other) => Err(Error::Invalid(format!("unknown Session mode {other}"))),
            }
        })
        .await
    }

    /// Set the Session's collaboration mode, creating the Session row if it did
    /// not exist, and record the transition durably.
    pub async fn set_mode(&self, session: &str, mode: CollaborationMode) -> Result<Event, Error> {
        let (session, mode) = (session.to_owned(), mode);
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let value = match mode {
                CollaborationMode::Build => "build",
                CollaborationMode::Plan => "plan",
            };
            tx.execute(
                "INSERT OR IGNORE INTO engine_session(id,next_seq,created_at_ms) VALUES(?1,0,?2)",
                params![session, crate::approval::now_ms() as i64],
            )?;
            tx.execute(
                "UPDATE engine_session SET mode=?2 WHERE id=?1",
                params![session, value],
            )?;
            let event = append(&tx, &session, "session.mode", json!({"mode":value}))?;
            tx.commit()?;
            Ok(event)
        })
        .await
    }

    /// Set the Session title. Records a durable event so replay and other
    /// clients observe the same title.
    pub async fn rename(&self, session: &str, title: &str) -> Result<Event, Error> {
        if title.len() > 1024 {
            return Err(Error::Invalid("session title is too long".into()));
        }
        let (session, title) = (session.to_owned(), title.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let now = crate::approval::now_ms() as i64;
            tx.execute(
                "INSERT OR IGNORE INTO engine_session(id,next_seq,created_at_ms) VALUES(?1,0,?2)",
                params![session, now],
            )?;
            tx.execute(
                "UPDATE engine_session SET title=?2, updated_at_ms=?3 WHERE id=?1",
                params![session, title, now],
            )?;
            let event = append(&tx, &session, "session.renamed", json!({"title":title}))?;
            tx.commit()?;
            Ok(event)
        })
        .await
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

    /// Every Session id in the engine database, in a stable order.
    pub async fn sessions(&self) -> Result<Vec<String>, Error> {
        self.call(|conn| {
            let mut statement = conn.prepare("SELECT id FROM engine_session ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            Ok(sessions)
        })
        .await
    }

    /// Create the Session row if it does not exist.
    pub async fn ensure(&self, session: &str) -> Result<(), Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO engine_session(id,next_seq,created_at_ms) VALUES(?1,0,?2)",
                params![session, crate::approval::now_ms() as i64],
            )?;
            Ok(())
        })
        .await
    }

    /// Safe-boundary promotion: all steers first, then one queued item only when
    /// idle. Projection and promotion events share the same transaction.
    pub async fn promote(&self, session: &str, idle: bool) -> Result<Vec<Event>, Error> {
        self.promote_inner(session, idle, None).await
    }

    /// `promote` under a Session claim: only the current owner may turn admitted
    /// input into a visible user message.
    pub async fn promote_fenced(
        &self,
        session: &str,
        idle: bool,
        lease: &SessionLease,
    ) -> Result<Vec<Event>, Error> {
        self.promote_inner(session, idle, Some(lease.clone())).await
    }

    async fn promote_inner(
        &self,
        session: &str,
        idle: bool,
        lease: Option<SessionLease>,
    ) -> Result<Vec<Event>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(lease) = &lease { require_lease(&tx, &session, lease)?; }
            let mut pending: Vec<(String, String, Option<String>)> = {
                let mut stmt = tx.prepare("SELECT id,prompt,attachments FROM engine_input WHERE session_id=?1 AND state='pending' AND delivery='steer' ORDER BY admitted_seq")?;
                let rows = stmt.query_map([&session], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                rows.collect::<Result<_,_>>()?
            };
            if pending.is_empty() && idle {
                if let Some(row) = tx.query_row("SELECT id,prompt,attachments FROM engine_input WHERE session_id=?1 AND state='pending' AND delivery='queue' ORDER BY admitted_seq LIMIT 1", [&session], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()? { pending.push(row); }
            }
            let mut events = Vec::new();
            for (id,prompt,attachments) in pending {
                let checkpoint=uuid::Uuid::new_v4().to_string();
                let e = append(&tx, &session, "input.promoted", json!({"input_id":id,"prompt":prompt,"checkpoint":checkpoint}))?;
                tx.execute("UPDATE engine_input SET state='promoted' WHERE id=?1", [&id])?;
                let mut parts = vec![json!({"type":"text","text":prompt})];
                if let Some(attachments) = attachments {
                    if let Ok(media) = serde_json::from_str::<Vec<Attachment>>(&attachments) {
                        parts.extend(media.iter().map(Attachment::part));
                    }
                }
                tx.execute("INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES(?1,?2,'user',?3,?4,?5)", params![session,e.seq,serde_json::to_string(&Value::Array(parts))?,checkpoint,e.recorded_at_ms])?;
                events.push(e);
            }
            tx.commit()?;
            Ok(events)
        }).await
    }

    pub async fn create_job(
        &self,
        session: &str,
        run: &str,
        call: &str,
        input: Value,
    ) -> Result<Value, Error> {
        self.create_job_for(session, run, call, input, "start_job")
            .await
    }

    /// Job admission bound to the dispatched intent of an arbitrary tool name
    /// (`start_job` for background tasks, `monitor` for command watches).
    pub async fn create_job_for(
        &self,
        session: &str,
        run: &str,
        call: &str,
        input: Value,
        tool_name: &str,
    ) -> Result<Value, Error> {
        let (session, run, call) = (session.to_owned(), run.to_owned(), call.to_owned());
        let tool_name = tool_name.to_owned();
        self.call(move |conn| {
            let tx=conn.transaction()?;let request=format!("{run}/{call}");
            let existing:Option<(String,String,String)>=tx.query_row("SELECT id,state,input FROM engine_job WHERE request_key=?1 AND session_id=?2",params![request,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((id,state,original))=existing {if serde_json::from_str::<Value>(&original)?!=input{return Err(Error::Conflict);}return Ok(json!({"job_id":id,"state":state,"duplicate":true}));}
            let original:Option<String>=tx.query_row("SELECT t.input FROM engine_tool t JOIN engine_run r ON r.id=t.run_id WHERE t.id=?1 AND t.name=?2 AND t.state='dispatched' AND r.session_id=?3 AND r.state='running'",params![request,tool_name,session],|r|r.get(0)).optional()?;
            let original=original.ok_or_else(||Error::Invalid("job admission requires its dispatched tool intent".into()))?;
            if serde_json::from_str::<Value>(&original)?["input"]!=input{return Err(Error::Conflict);}
            let id=uuid::Uuid::new_v4().to_string();tx.execute("INSERT INTO engine_job VALUES(?1,?2,?3,'queued',?4,NULL)",params![id,session,request,serde_json::to_string(&input)?])?;
            append(&tx,&session,"job.admitted",json!({"job_id":id,"request_key":request}))?;tx.commit()?;Ok(json!({"job_id":id,"state":"queued","duplicate":false}))
        }).await
    }

    pub async fn job(&self, session: &str, id: &str) -> Result<Option<Value>, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let row:Option<(String,Option<String>)>=conn.query_row("SELECT state,result FROM engine_job WHERE id=?1 AND session_id=?2",params![id,session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            row.map(|(state,result)|Ok(json!({"job_id":id,"state":state,"result":result.map(|v|serde_json::from_str::<Value>(&v)).transpose()?}))).transpose()
        }).await
    }

    pub async fn jobs(&self, session: &str) -> Result<Vec<Value>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id,state FROM engine_job WHERE session_id=?1 ORDER BY rowid DESC LIMIT 100",
            )?;
            let rows = stmt.query_map([session], |r| {
                Ok(json!({"job_id":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?}))
            })?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    pub async fn start_job(&self, session: &str, id: &str) -> Result<Event, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;if tx.execute("UPDATE engine_job SET state='running' WHERE id=?1 AND session_id=?2 AND state='queued'",params![id,session])?!=1{return Err(Error::Invalid("job is not queued".into()));}
            let event=append(&tx,&session,"job.started",json!({"job_id":id}))?;tx.commit()?;Ok(event)
        }).await
    }

    pub async fn finish_job(
        &self,
        session: &str,
        id: &str,
        state: &str,
        result: Value,
    ) -> Result<Admission, Error> {
        let (session, id, state) = (session.to_owned(), id.to_owned(), state.to_owned());
        if !["completed", "failed", "cancelled", "interrupted", "unknown"].contains(&state.as_str())
        {
            return Err(Error::Invalid("invalid terminal job state".into()));
        }
        self.call(move |conn| {
            let tx=conn.transaction()?;if tx.execute("UPDATE engine_job SET state=?3,result=?4 WHERE id=?1 AND session_id=?2 AND state IN ('queued','running')",params![id,session,state,serde_json::to_string(&result)?])?!=1{return Err(Error::Invalid("job is not active".into()));}
            append(&tx,&session,"job.finished",json!({"job_id":id,"state":state}))?;
            let admission = admit_input(&tx, &Input {
                session_id: session.clone(),
                input_id: format!("job:{id}:finished"),
                prompt: format!("Background job {id} finished with state {state}. Read its stored result with job_status and continue eligible work."),
                delivery: Delivery::Steer,
            }, None, &[])?;
            tx.commit()?;
            Ok(admission)
        }).await
    }

    pub async fn recover_jobs(&self) -> Result<(), Error> {
        self.call(|conn| {
            let tx=conn.transaction()?;
            let jobs:Vec<(String,String,String)>={let mut stmt=tx.prepare("SELECT id,session_id,state FROM engine_job WHERE state IN ('queued','running')")?;let rows=stmt.query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;rows.collect::<Result<_,_>>()?};
            for (id,session,state) in jobs {
                let terminal=if state=="queued"{"interrupted"}else{"unknown"};let result=json!({"error":"runtime ownership lost; no automatic replay"});
                tx.execute("UPDATE engine_job SET state=?2,result=?3 WHERE id=?1",params![id,terminal,serde_json::to_string(&result)?])?;
                append(&tx,&session,"job.finished",json!({"job_id":id,"state":terminal,"recovered":true}))?;
            }
            tx.commit()?;Ok(())
        }).await
    }

    /// Persist exactly what the provider will observe, independent of mutable
    /// files. Identical baseline/sources reuse the current epoch and cache body.
    pub async fn select_context(&self, session: &str, bundle: ContextBundle) -> Result<u64, Error> {
        self.select_context_inner(session, bundle, None).await
    }

    /// `select_context` under a Session claim: a superseded writer cannot move
    /// the Session to a new context epoch.
    pub async fn select_context_fenced(
        &self,
        session: &str,
        bundle: ContextBundle,
        lease: &SessionLease,
    ) -> Result<u64, Error> {
        self.select_context_inner(session, bundle, Some(lease.clone()))
            .await
    }

    async fn select_context_inner(
        &self,
        session: &str,
        bundle: ContextBundle,
        lease: Option<SessionLease>,
    ) -> Result<u64, Error> {
        if bundle.system.len() > 65536
            || bundle.sources.len() > 16
            || serde_json::to_vec(&bundle.sources)?.len() > 65536
            || context_digest(&bundle.system, &bundle.sources)? != bundle.fingerprint
        {
            return Err(Error::Invalid("invalid context bundle".into()));
        }
        let session = session.to_owned();
        self.call(move |conn| {
            let tx=conn.transaction()?;
            if let Some(lease) = &lease { require_lease(&tx, &session, lease)?; }
            let previous:Option<(u64,String)>=tx.query_row("SELECT epoch,fingerprint FROM engine_context WHERE session_id=?1 ORDER BY epoch DESC LIMIT 1",[&session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((epoch,fingerprint))=&previous {if fingerprint==&bundle.fingerprint{return Ok(*epoch);}}
            let epoch=previous.map(|(epoch,_)|epoch+1).unwrap_or(1);
            let event=append(&tx,&session,"context.changed",json!({"epoch":epoch,"fingerprint":bundle.fingerprint,"sources":bundle.sources}))?;
            tx.execute("INSERT INTO engine_context VALUES(?1,?2,?3,?4,?5,?6)",params![session,epoch,bundle.fingerprint,bundle.system,serde_json::to_string(&bundle.sources)?,event.seq])?;
            tx.commit()?;Ok(epoch)
        }).await
    }

    pub async fn context(&self, session: &str, epoch: Option<u64>) -> Result<Option<Value>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let row:Option<(u64,String,String,String,u64)>=conn.query_row("SELECT epoch,fingerprint,system,sources,selected_seq FROM engine_context WHERE session_id=?1 AND (?2 IS NULL OR epoch=?2) ORDER BY epoch DESC LIMIT 1",params![session,epoch],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            row.map(|(epoch,fingerprint,system,sources,seq)|Ok(json!({"epoch":epoch,"fingerprint":fingerprint,"system":system,"sources":serde_json::from_str::<Value>(&sources)?,"selected_seq":seq}))).transpose()
        }).await
    }

    /// One read transaction captures a replay cursor and its projections. This
    /// is a bounded resync view, not an unbounded transcript dump.
    pub async fn snapshot(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let cursor:u64=tx.query_row("SELECT next_seq FROM engine_session WHERE id=?1",[&session],|r|r.get(0)).optional()?.ok_or_else(||Error::Invalid("Session does not exist".into()))?;
            let location:Option<String>=tx.query_row("SELECT root FROM engine_location WHERE session_id=?1",[&session],|r|r.get(0)).optional()?;
            let messages=projected(&tx,&session,cursor)?;
            // Context readers need the cut and summary from the same transaction
            // as the visible messages. A second selected-history read could race
            // a compaction/revert and produce a mixed-generation transcript.
            let selection:Option<(u64,String,u64,Option<u64>)>=tx.query_row(
                "SELECT c.through_seq,c.summary,c.created_seq,e.recorded_at_ms FROM engine_compaction c JOIN engine_event e ON e.session_id=c.session_id AND e.seq=c.created_seq WHERE c.session_id=?1 ORDER BY c.created_seq DESC LIMIT 1",
                [&session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
            ).optional()?;
            let selection=selection.map(|(through,summary,seq,time)|json!({"through_seq":through,"summary":summary,"seq":seq,"recorded_at_ms":time}));
            let parent:Option<String>=tx.query_row("SELECT parent_session_id FROM engine_lineage WHERE session_id=?1",[&session],|row|row.get(0)).optional()?;
            let active:Option<String>=tx.query_row("SELECT id FROM engine_run WHERE session_id=?1 AND state='running'",[&session],|r|r.get(0)).optional()?;
            let pending={
                let mut stmt=tx.prepare("SELECT id,delivery,admitted_seq,substr(prompt,1,200),length(prompt)>200 FROM engine_input WHERE session_id=?1 AND state='pending' ORDER BY admitted_seq LIMIT 1001")?;
                let rows=stmt.query_map([&session],|r|Ok(json!({"input_id":r.get::<_,String>(0)?,"delivery":r.get::<_,String>(1)?,"admitted_seq":r.get::<_,u64>(2)?,"preview":r.get::<_,String>(3)?,"truncated":r.get::<_,bool>(4)?})))?;
                rows.collect::<Result<Vec<_>,_>>()?
            };
            if pending.len()>1000{return Err(Error::Invalid("snapshot pending limit; inspect inbox separately".into()));}
            let approvals={
                let mut stmt=tx.prepare("SELECT binding FROM engine_approval WHERE session_id=?1 AND state='pending'")?;
                let rows=stmt.query_map([&session],|r|r.get::<_,String>(0))?;
                rows.map(|r|Ok(serde_json::from_str::<Value>(&r?)?)).collect::<Result<Vec<_>,Error>>()?
            };
            let context:Option<(u64,String,String)>=tx.query_row("SELECT epoch,fingerprint,sources FROM engine_context WHERE session_id=?1 ORDER BY epoch DESC LIMIT 1",[&session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let context=context.map(|(epoch,fingerprint,sources)|Ok::<_,Error>(json!({"epoch":epoch,"fingerprint":fingerprint,"sources":serde_json::from_str::<Value>(&sources)?}))).transpose()?;
            let state=crate::state::projection(&tx,&session,cursor)?;
            let questions=crate::question::pending(&tx,&session)?;
            let wakeups=crate::wakeup::pending(&tx,&session)?;
            let crons=crate::cron::pending(&tx,&session)?;
            let model_selection=crate::session_model::selected(&tx,&session)?;
            let mode:String=tx.query_row("SELECT mode FROM engine_session WHERE id=?1",[&session],|r|r.get(0)).optional()?.unwrap_or_else(||"build".into());
            let (title,created_at_ms,updated_at_ms):(String,Option<i64>,Option<i64>)=tx.query_row(
                "SELECT title,created_at_ms,updated_at_ms FROM engine_session WHERE id=?1",
                [&session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
            )?;
            let snapshot=json!({"session_id":session,"parent_session_id":parent,"cursor":cursor,"location":location,"mode":mode,"title":title,"created_at_ms":created_at_ms,"updated_at_ms":updated_at_ms,"messages":messages,"selection":selection,"pending":pending,"active_run":active,"approvals":approvals,"context":context,"state":state,"questions":questions,"wakeups":wakeups,"crons":crons,"model_selection":model_selection});
            if serde_json::to_vec(&snapshot)?.len()>4*1024*1024{return Err(Error::Invalid("snapshot exceeds limit; use events pagination".into()));}
            tx.commit()?;Ok(snapshot)
        }).await
    }

    /// Fork only a closed message prefix, never executions, pending inbox,
    /// permissions, side effects or filesystem state. Target ID reconciles an
    /// exact retry even when the parent has advanced after the first commit.
    pub async fn lineage_parent(&self, session: &str) -> Result<Option<String>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT parent_session_id FROM engine_lineage WHERE session_id=?1",
                    [&session],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await
    }

    /// A fork may propose only a completed parent prefix at its own cursor.
    /// The provider checks exact wire parameters/history before using the hint.
    /// Proofs live in a side table: the replay-pinned journal never carries them.
    pub(crate) async fn cache_affinity(
        &self,
        session: &str,
    ) -> Result<Option<crate::cache_affinity::Proof>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let row: Option<(String, String, String, String, i64)> = conn.query_row(
                "SELECT p.affinity_session,p.route_hash,p.parameters_hash,p.history_hash,p.message_count FROM engine_cache_prefix p JOIN engine_lineage l ON l.parent_session_id=p.session_id WHERE l.session_id=?1 AND p.session_seq<=l.message_seq",
                [&session], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            ).optional()?;
            Ok(row.map(|(affinity_session,route_hash,parameters_hash,history_hash,message_count)|crate::cache_affinity::Proof{affinity_session,route_hash,parameters_hash,history_hash,message_count:usize::try_from(message_count).unwrap_or(0)}))
        }).await
    }

    /// Wall-clock-free side-table write. Losing it only loses an optimization.
    pub(crate) async fn record_cache_prefix(
        &self,
        session: &str,
        proof: crate::cache_affinity::Proof,
    ) {
        let session = session.to_owned();
        let _ = self.call(move |conn| {
            conn.execute(
                "INSERT INTO engine_cache_prefix(session_id,affinity_session,route_hash,parameters_hash,history_hash,message_count,session_seq) VALUES(?1,?2,?3,?4,?5,?6,(SELECT COALESCE(MAX(seq),0) FROM engine_message WHERE session_id=?1))
                 ON CONFLICT(session_id) DO UPDATE SET affinity_session=excluded.affinity_session,route_hash=excluded.route_hash,parameters_hash=excluded.parameters_hash,history_hash=excluded.history_hash,message_count=excluded.message_count,session_seq=excluded.session_seq",
                params![session,proof.affinity_session,proof.route_hash,proof.parameters_hash,proof.history_hash,proof.message_count as i64],
            )?;
            Ok(())
        }).await;
    }

    pub async fn fork(
        &self,
        parent: &str,
        target: &str,
        message_seq: Option<u64>,
    ) -> Result<Value, Error> {
        if target.is_empty() || target.len() > 256 || parent == target {
            return Err(Error::Invalid("invalid fork target".into()));
        }
        let (parent, target) = (parent.to_owned(), target.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let existing:Option<(String,u64)>=tx.query_row("SELECT parent_session_id,message_seq FROM engine_lineage WHERE session_id=?1",[&target],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((source,seq))=existing {
                if source!=parent||message_seq.is_some_and(|requested|requested!=seq){return Err(Error::Conflict);}
                return Ok(json!({"session_id":target,"parent_session_id":parent,"message_seq":seq,"duplicate":true}));
            }
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",[&target],|r|r.get::<_,bool>(0))? {return Err(Error::Conflict);}
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",[&parent],|r|r.get(0))?;
            if !exists{return Err(Error::Invalid("parent Session does not exist".into()));}
            if message_seq.is_none()&&tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",[&parent],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("active parent requires an explicit closed message boundary".into()));}
            let seq=match message_seq {Some(seq)=>seq,None=>tx.query_row("SELECT COALESCE(MAX(seq),0) FROM engine_message WHERE session_id=?1",[&parent],|r|r.get(0))?};
            if seq!=0&&!tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_message WHERE session_id=?1 AND seq=?2)",params![parent,seq],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("fork cursor must be a committed message boundary".into()));}
            let messages=projected(&tx,&parent,seq)?;
            closed_prefix(&messages)?;
            // A fork must not escape the parent's read-only collaboration mode.
            let mode:String=tx.query_row("SELECT mode FROM engine_session WHERE id=?1",[&parent],|row|row.get(0))?;
            tx.execute(
                "INSERT INTO engine_session(id,created_at_ms,mode) VALUES(?1,?2,?3)",
                params![target, crate::approval::now_ms() as i64, mode],
            )?;
            tx.execute("INSERT INTO engine_lineage VALUES(?1,?2,?3)",params![target,parent,seq])?;
            tx.execute("INSERT INTO engine_location SELECT ?1,root FROM engine_location WHERE session_id=?2",params![target,parent])?;
            append(&tx,&target,"session.forked",json!({"parent_session_id":parent,"message_seq":seq}))?;
            let mut message_map=std::collections::HashMap::new();
            for message in messages {
                let mut copied=project_message_at(&tx,&target,message["role"].as_str().ok_or_else(||Error::Invalid("projected role".into()))?,message["content"].clone(),message["checkpoint"].as_str(),None,message["recorded_at_ms"].as_u64())?;
                if message["role"] == "user" {
                    let source = message["seq"].as_u64().ok_or_else(||Error::Invalid("projected message seq".into()))?;
                    let original:Option<(String,String,Option<String>)>=tx.query_row(
                        "SELECT prompt,delivery,attachments FROM engine_input WHERE session_id=?1 AND id=COALESCE((SELECT json_extract(data,'$.input_id') FROM engine_event WHERE session_id=?1 AND seq=?2 AND kind='input.promoted'),(SELECT id FROM engine_input WHERE session_id=?1 AND admitted_seq=?2 AND state='promoted'))",
                        params![parent,source],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                    ).optional()?;
                    let (prompt,delivery,attachments) = original.unwrap_or_else(|| {
                        let text=message["content"].as_array().into_iter().flatten().filter(|part|part["type"]=="text").filter_map(|part|part["text"].as_str()).collect::<Vec<_>>().join("");
                        (text,"steer".to_owned(),None)
                    });
                    let input_id=format!("msg_{target}_{}",copied.seq);
                    // Historical copies are promoted, never executable inbox
                    // inputs. Retrying the public copied ID must reconcile it,
                    // not admit the same visible prompt for a second execution.
                    tx.execute("INSERT INTO engine_input(id,session_id,prompt,delivery,state,admitted_seq,attachments) VALUES(?1,?2,?3,?4,'promoted',?5,?6)",params![input_id,target,prompt,delivery,copied.seq,attachments])?;
                    copied.data["input_id"]=json!(input_id);
                    copied.data["delivery"]=json!(delivery);
                    // Finalize the copy payload before this transaction is
                    // committed/published; no existing ledger row is rewritten.
                    tx.execute("UPDATE engine_event SET data=?3 WHERE session_id=?1 AND seq=?2",params![target,copied.seq,serde_json::to_string(&copied.data)?])?;
                }
                if let Some(source)=message["seq"].as_u64(){
                    message_map.insert(source,copied.seq);
                    if let Some((mut profile, time)) = assistant_profile(&tx, &parent, source)? {
                        profile["origin"] = json!({"session_id":parent,"assistant_seq":source});
                        profile["assistant_seq"] = json!(copied.seq);
                        if let Some(profile) = profile.as_object_mut() {
                            profile.remove("anchor_seq");
                        }
                        append_at(&tx,&target,"assistant.identity",profile,time)?;
                    }
                }
            }
            let context:Option<(u64,String,String,String)>=tx.query_row("SELECT epoch,fingerprint,system,sources FROM engine_context WHERE session_id=?1 AND selected_seq<=?2 ORDER BY epoch DESC LIMIT 1",params![parent,seq],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((parent_epoch,fingerprint,system,sources))=context {
                let event=append(&tx,&target,"context.inherited",json!({"epoch":1,"parent_session_id":parent,"parent_epoch":parent_epoch,"fingerprint":fingerprint}))?;
                tx.execute("INSERT INTO engine_context VALUES(?1,1,?2,?3,?4,?5)",params![target,fingerprint,system,sources,event.seq])?;
            }
            let source_watermark=if message_seq.is_none(){tx.query_row("SELECT next_seq FROM engine_session WHERE id=?1",[&parent],|r|r.get::<_,u64>(0))?}else{seq};
            if let Some(binding)=crate::session_model::selected_at(&tx,&parent,source_watermark)? {
                append(&tx,&target,"session.model.selected",json!({"binding":binding,"inherited":true}))?;
            }
            let inherited=crate::state::projection(&tx,&parent,source_watermark)?;
            for kind in ["todos","goal"] {
                if !inherited[kind].is_null(){append(&tx,&target,"session.state.updated",json!({"operation_id":format!("fork:{target}:{kind}"),"kind":kind,"value":inherited[kind]["value"],"expected_revision":null,"parent_revision":inherited[kind]["revision"]}))?;}
            }
            let checkpoint:Option<(u64,String)>=tx.query_row("SELECT through_seq,summary FROM engine_compaction WHERE session_id=?1 AND created_seq<=?2 AND through_seq<=?3 ORDER BY created_seq DESC LIMIT 1",params![parent,source_watermark,seq],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((through,summary))=checkpoint {
                let through=*message_map.get(&through).ok_or_else(||Error::Invalid("fork checkpoint missing".into()))?;
                let id=uuid::Uuid::new_v4().to_string();let event=append(&tx,&target,"history.compacted",json!({"compaction_id":id,"through_message_seq":through,"summary":summary,"inherited":true}))?;
                tx.execute("INSERT INTO engine_compaction VALUES(?1,?2,?3,?4,?5)",params![id,target,through,summary,event.seq])?;
            }
            tx.commit()?;
            Ok(json!({"session_id":target,"parent_session_id":parent,"message_seq":seq,"duplicate":false}))
        }).await
    }

    /// Rewind the visible projection to before the user message carrying
    /// `checkpoint`. Messages from that boundary onward are marked reverted
    /// (soft, so `unrevert` restores them) and any compaction at or after it is
    /// dropped. The event ledger stays append-only; nothing is silently lost.
    pub async fn revert(&self, session: &str, checkpoint: &str) -> Result<Value, Error> {
        if checkpoint.is_empty() || checkpoint.len() > 256 {
            return Err(Error::Invalid("invalid revert checkpoint".into()));
        }
        let (session, checkpoint) = (session.to_owned(), checkpoint.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",[&session],|r|r.get::<_,bool>(0))? {
                return Err(Error::Invalid("revert requires an idle Session".into()));
            }
            let seq: Option<u64> = tx.query_row("SELECT seq FROM engine_message WHERE session_id=?1 AND checkpoint=?2 AND role='user'",params![session,checkpoint],|r|r.get(0)).optional()?;
            let seq = seq.ok_or_else(|| Error::Invalid("revert checkpoint not found".into()))?;
            let reverted = tx.execute("UPDATE engine_message SET reverted=1 WHERE session_id=?1 AND seq>=?2 AND reverted=0",params![session,seq])?;
            tx.execute("DELETE FROM engine_compaction WHERE session_id=?1 AND through_seq>=?2",params![session,seq])?;
            append(&tx,&session,"session.reverted",json!({"checkpoint":checkpoint,"from_seq":seq,"reverted":reverted}))?;
            tx.commit()?;
            Ok(json!({"checkpoint":checkpoint,"from_seq":seq,"reverted":reverted}))
        }).await
    }

    /// Restore every reverted message in the Session. Compaction dropped by a
    /// revert is not regenerated; visible messages are.
    pub async fn unrevert(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let restored = tx.execute(
                "UPDATE engine_message SET reverted=0 WHERE session_id=?1 AND reverted=1",
                [&session],
            )?;
            append(
                &tx,
                &session,
                "session.unreverted",
                json!({"restored":restored}),
            )?;
            tx.commit()?;
            Ok(json!({"restored":restored}))
        })
        .await
    }

    pub async fn history(&self, session: &str) -> Result<Vec<Message>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT role,content,checkpoint,recorded_at_ms FROM engine_message WHERE session_id=?1 AND reverted=0 ORDER BY seq",
            )?;
            let rows = stmt.query_map([session], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<u64>>(3)?,
                ))
            })?;
            rows.map(|row| {
                let (role, content, checkpoint, recorded_at_ms) = row?;
                Ok(Message {
                    role,
                    content: serde_json::from_str(&content)?,
                    checkpoint,
                    recorded_at_ms,
                })
            })
            .collect()
        })
        .await
    }

    pub async fn events(&self, session: &str, after: u64, limit: u32) -> Result<Vec<Event>, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut stmt = conn.prepare("SELECT seq,kind,data,recorded_at_ms FROM engine_event WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
            let rows = stmt.query_map(params![session,after,limit.min(1000)], |r| Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<u64>>(3)?)))?;
            rows.map(|row| { let (seq,kind,data,recorded_at_ms) = row?; Ok(Event { session_id:session.clone(),seq,kind,data:serde_json::from_str(&data)?,recorded_at_ms }) }).collect()
        }).await
    }

    /// A bounded journal lookup for observations that survive runner restarts.
    /// Do not page the entire transcript to find the preceding request.
    pub(crate) async fn latest_event(
        &self,
        session: &str,
        kind: &str,
    ) -> Result<Option<Event>, Error> {
        let (session, kind) = (session.to_owned(), kind.to_owned());
        self.call(move |conn| {
            let row = conn.query_row(
                "SELECT seq,data,recorded_at_ms FROM engine_event WHERE session_id=?1 AND kind=?2 ORDER BY seq DESC LIMIT 1",
                params![session, kind],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<u64>>(2)?)),
            ).optional()?;
            row.map(|(seq, data, recorded_at_ms)| Ok(Event {
                session_id: session, seq, kind, data: serde_json::from_str(&data)?, recorded_at_ms,
            })).transpose()
        }).await
    }

    pub async fn start_run(&self, session: &str, run: &str) -> Result<Event, Error> {
        self.start_run_inner(session, run, None).await
    }

    /// `start_run` under a Session claim: a superseded writer cannot open a run.
    pub async fn start_run_fenced(
        &self,
        session: &str,
        run: &str,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.start_run_inner(session, run, Some(lease.clone()))
            .await
    }

    async fn start_run_inner(
        &self,
        session: &str,
        run: &str,
        lease: Option<SessionLease>,
    ) -> Result<Event, Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(lease) = &lease {
                require_lease(&tx, &session, lease)?;
            }
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
                "INSERT INTO engine_message(session_id,seq,role,content,recorded_at_ms) VALUES(?1,?2,?3,?4,?5)",
                params![session, e.seq, role, serde_json::to_string(&content)?, e.recorded_at_ms],
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
        self.tool_dispatch_inner(session, run, id, name, input, None)
            .await
    }

    /// `tool_dispatch` under a Session claim: a superseded writer cannot start a
    /// tool side effect.
    pub async fn tool_dispatch_fenced(
        &self,
        session: &str,
        run: &str,
        id: &str,
        name: &str,
        input: Value,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.tool_dispatch_inner(session, run, id, name, input, Some(lease.clone()))
            .await
    }

    async fn tool_dispatch_inner(
        &self,
        session: &str,
        run: &str,
        id: &str,
        name: &str,
        input: Value,
        lease: Option<SessionLease>,
    ) -> Result<Event, Error> {
        let (session, run, id, name) = (
            session.to_owned(),
            run.to_owned(),
            id.to_owned(),
            name.to_owned(),
        );
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(lease) = &lease {
                require_lease(&tx, &session, lease)?;
            }
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
        self.tool_settle_inner(session, id, result, None).await
    }

    /// `tool_settle` under a Session claim: a superseded writer cannot settle a
    /// tool call it no longer owns.
    pub async fn tool_settle_fenced(
        &self,
        session: &str,
        id: &str,
        result: Value,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.tool_settle_inner(session, id, result, Some(lease.clone()))
            .await
    }

    async fn tool_settle_inner(
        &self,
        session: &str,
        id: &str,
        result: Value,
        lease: Option<SessionLease>,
    ) -> Result<Event, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(lease) = &lease { require_lease(&tx, &session, lease)?; }
            let changed = tx.execute("UPDATE engine_tool SET state='completed' WHERE id=?1 AND state='dispatched' AND run_id IN (SELECT id FROM engine_run WHERE session_id=?2 AND state='running')",params![id,session])?;
            if changed != 1 { return Err(Error::Invalid("tool call is not dispatchable".into())); }
            let e = append(&tx,&session,"tool.completed",json!({"call_id":id,"result":result}))?;
            tx.commit()?;
            Ok(e)
        }).await
    }

    /// Sessions holding unresolved (scheduled or adopted) timers, wakeup and
    /// cron combined, budget-capped for the supervisor scan.
    pub async fn timer_sessions(&self) -> Result<Vec<Value>, Error> {
        self.call(|conn| {
            let mut stmt=conn.prepare(
                "SELECT DISTINCT q.session_id FROM engine_event q WHERE q.kind IN ('wakeup.scheduled','cron.scheduled') AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind IN ('wakeup.resolved','cron.resolved') AND json_extract(r.data,'$.timer_id')=json_extract(q.data,'$.timer_id') AND json_extract(r.data,'$.cron_id')=json_extract(q.data,'$.cron_id')) LIMIT 65",
            )?;
            let rows=stmt.query_map([],|row|{
                let session:String=row.get(0)?;
                Ok(json!({"session_id":session}))
            })?;
            let mut sessions=Vec::new();
            for row in rows{
                sessions.push(row.map_err(Error::from)?);
            }
            Ok(sessions)
        }).await
    }
    /// Process heartbeat for timer ownership. The epoch advances on every
    /// renewal so a future cross-process supervisor can order leases.
    pub async fn heartbeat_lease(&self, session: &str, interval_ms: i64) -> Result<i64, Error> {
        Ok(self.claim_session(session, interval_ms).await?.epoch as i64)
    }

    /// Renew this writer's claim without changing its epoch. Renewal must not
    /// bump the fence, or a long turn would invalidate its own lease on every
    /// heartbeat; a superseded writer learns it lost ownership here.
    pub async fn renew_session(
        &self,
        lease: &SessionLease,
        interval_ms: i64,
    ) -> Result<SessionLease, Error> {
        let (lease, interval_ms) = (lease.clone(), interval_ms);
        self.call(move |conn| {
            let now = crate::approval::now_ms() as i64;
            let changed = conn.execute(
                "UPDATE engine_lease SET last_ms=?3, interval_ms=?4 WHERE session_id=?1 AND epoch=?2",
                params![lease.session, lease.epoch as i64, now, interval_ms],
            )?;
            if changed != 1 {
                return Err(Error::Fenced);
            }
            Ok(lease)
        })
        .await
    }
    /// Claim Session execution ownership. Every claim advances the durable
    /// epoch, which is the fence that Session-scoped writes must present.
    pub async fn claim_session(
        &self,
        session: &str,
        interval_ms: i64,
    ) -> Result<SessionLease, Error> {
        let (session, interval_ms) = (session.to_owned(), interval_ms);
        self.call(move |conn| {
            let now = crate::approval::now_ms() as i64;
            let epoch: i64 = conn.query_row(
                "INSERT INTO engine_lease(session_id,interval_ms,last_ms,epoch) VALUES(?1,?2,?3,1)\n                 ON CONFLICT(session_id) DO UPDATE SET interval_ms=excluded.interval_ms,last_ms=excluded.last_ms,epoch=engine_lease.epoch+1 RETURNING epoch",
                params![session, interval_ms, now],
                |row| row.get(0),
            )?;
            Ok(SessionLease { session: session.clone(), epoch: epoch as u64 })
        })
        .await
    }
    /// A lease is alive while its last heartbeat is within twice the declared
    /// interval; expired or missing leases make timers adoptable.
    pub async fn has_running_runs(&self) -> Result<bool, Error> {
        self.call(|conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_run WHERE state='running')",
                [],
                |row| row.get(0),
            )?)
        })
        .await
    }

    pub async fn lease_alive(&self, session: &str) -> Result<bool, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let row: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT interval_ms,last_ms FROM engine_lease WHERE session_id=?1",
                    [&session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            Ok(row.is_some_and(|(interval, last)| {
                crate::approval::now_ms().saturating_sub(last as u64) < 2 * interval.max(1) as u64
            }))
        })
        .await
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

    /// Append one Session-scoped event only while this writer still holds the
    /// claim. The fence check runs inside the same transaction as the append,
    /// so a superseding claim cannot slip in between them.
    pub async fn record_fenced(
        &self,
        session: &str,
        kind: &str,
        data: Value,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        let (session, kind, lease) = (session.to_owned(), kind.to_owned(), lease.clone());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let event = append_fenced(&tx, &session, &kind, data, &lease)?;
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
        anchor: Option<u64>,
        content: Value,
    ) -> Result<Event, Error> {
        self.assistant_projection(session, run, anchor, content, None, None)
            .await
    }

    /// `assistant_reply` under a Session claim.
    pub async fn assistant_reply_fenced(
        &self,
        session: &str,
        run: &str,
        anchor: Option<u64>,
        content: Value,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.assistant_projection(session, run, anchor, content, None, Some(lease.clone()))
            .await
    }

    /// Bind successful reply identity to its assistant projection atomically.
    pub async fn assistant_reply_profiled(
        &self,
        session: &str,
        run: &str,
        step: usize,
        anchor: Option<u64>,
        content: Value,
        identity: Option<crate::provider::Identity>,
    ) -> Result<Event, Error> {
        self.assistant_projection(
            session,
            run,
            anchor,
            content,
            Some(json!({"run_id":run,"step":step,"provider":identity,"agent":null})),
            None,
        )
        .await
    }

    /// `assistant_reply_profiled` under a Session claim.
    #[allow(clippy::too_many_arguments)]
    pub async fn assistant_reply_profiled_fenced(
        &self,
        session: &str,
        run: &str,
        step: usize,
        anchor: Option<u64>,
        content: Value,
        identity: Option<crate::provider::Identity>,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.assistant_projection(
            session,
            run,
            anchor,
            content,
            Some(json!({"run_id":run,"step":step,"provider":identity,"agent":null})),
            Some(lease.clone()),
        )
        .await
    }

    async fn assistant_projection(
        &self,
        session: &str,
        run: &str,
        anchor: Option<u64>,
        content: Value,
        profile: Option<Value>,
        lease: Option<SessionLease>,
    ) -> Result<Event, Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            if let Some(lease) = &lease { require_lease(&tx, &session, lease)?; }
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
            let event=project_message(&tx,&session,"assistant",content,None,anchor)?;
            if let Some(mut profile) = profile {
                profile["assistant_seq"] = json!(event.seq);
                // The step-start anchor lets a client name the streamed part
                // before the commit and reach the same id afterwards. `assistant_seq`
                // keeps its own meaning (this event's sequence), so replay and the
                // fork identity correlation stay untouched.
                if let Some(anchor) = anchor {
                    profile["anchor_seq"] = json!(anchor);
                }
                append_at(&tx,&session,"assistant.identity",profile,event.recorded_at_ms)?;
            }
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
            let name: String = tx.query_row("SELECT name FROM engine_tool WHERE id=?1",params![key],|row| row.get(0))?;
            let mut result = result;
            let image = if name == "read_image" && !is_error {
                let image = result.as_object_mut().and_then(|result| result.remove("image"))
                    .ok_or_else(|| Error::Invalid("image tool result is missing its attachment".into()))?;
                let attachment: crate::protocol::Attachment = serde_json::from_value(image)?;
                attachment.validate()?;
                result["image_attached"] = json!(true);
                Some(attachment.part())
            } else { None };
            append(&tx,&session,"tool.completed",json!({"call_id":key,"result":result,"result_json":serde_json::to_string(&result)?,"is_error":is_error}))?;
            let mut content = vec![json!({"type":"tool_result","tool_use_id":id,"content":serde_json::to_string(&result)?,"is_error":is_error})];
            if let Some(image) = image { content.push(image); }
            let event=project_message(&tx,&session,"user",json!(content),None,None)?;
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
            if response.input_hash!=approval.input_hash||response.policy_revision!=approval.policy_revision||response.decision==Decision::Ask||response.matcher.as_ref().is_some_and(|matcher|matcher!=&approval.matcher) {return Err(Error::ApprovalMismatch);}
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
        self.finish_run_inner(session, run, reason, None).await
    }

    /// `finish_run` under a Session claim: only the current owner closes its run.
    pub async fn finish_run_fenced(
        &self,
        session: &str,
        run: &str,
        reason: &str,
        lease: &SessionLease,
    ) -> Result<Event, Error> {
        self.finish_run_inner(session, run, reason, Some(lease.clone()))
            .await
    }

    async fn finish_run_inner(
        &self,
        session: &str,
        run: &str,
        reason: &str,
        lease: Option<SessionLease>,
    ) -> Result<Event, Error> {
        let (session, run, reason) = (session.to_owned(), run.to_owned(), reason.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if let Some(lease) = &lease {
                require_lease(&tx, &session, lease)?;
            }
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
            // Aggregate billed usage for the run: each provider attempt already
            // recorded a `usage` event, so a turn sums them (including failed
            // attempts) instead of reporting one step or a character estimate.
            let usage_events: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT data FROM engine_event WHERE session_id=?1 AND kind='usage'",
                )?;
                let rows = stmt.query_map([&session], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .filter(|data| {
                        serde_json::from_str::<Value>(data)
                            .ok()
                            .is_some_and(|event| event["run_id"].as_str() == Some(run.as_str()))
                    })
                    .collect()
            };
            let mut total = Value::Null;
            let mut steps = 0u64;
            for data in usage_events {
                if let Ok(event) = serde_json::from_str::<Value>(&data) {
                    steps += 1;
                    merge_usage(&mut total, &event["usage"]);
                }
            }
            append(
                &tx,
                &session,
                "run.usage",
                json!({"run_id":run,"steps":steps,"usage":total}),
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

/// Recursively sum numeric leaves so per-step provider usage aggregates across a
/// run regardless of provider field names (`input_tokens` vs `prompt_tokens`, or
/// nested `*_details`). Non-numeric leaves take the latest value.
fn merge_usage(acc: &mut Value, next: &Value) {
    match next {
        Value::Object(update) => {
            if !acc.is_object() {
                *acc = Value::Object(serde_json::Map::new());
            }
            let current = acc.as_object_mut().expect("object");
            for (key, value) in update {
                // Raw provider payloads are audit-only; counting them would
                // double every normalized number.
                if key == crate::usage::PROVIDER_METADATA {
                    current.insert(key.clone(), value.clone());
                    continue;
                }
                merge_usage(current.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        Value::Number(update) => {
            let sum = acc.as_number().cloned().and_then(|current| {
                if let (Some(left), Some(right)) = (current.as_i64(), update.as_i64()) {
                    Some(json!(left + right))
                } else {
                    match (current.as_f64(), update.as_f64()) {
                        (Some(left), Some(right)) => Some(json!(left + right)),
                        _ => None,
                    }
                }
            });
            *acc = sum.unwrap_or_else(|| next.clone());
        }
        _ => *acc = next.clone(),
    }
}

pub(crate) fn admit_input(
    tx: &Transaction<'_>,
    input: &Input,
    root: Option<&str>,
    attachments: &[Attachment],
) -> Result<Admission, Error> {
    if input.session_id.is_empty()
        || input.input_id.is_empty()
        || input.prompt.is_empty()
        || input.session_id.len() > 256
        || input.input_id.len() > 256
        || input.prompt.len() > 1024 * 1024
    {
        return Err(Error::Invalid(
            "session_id, input_id and prompt must be nonempty".into(),
        ));
    }
    let serialized = serde_json::to_string(attachments)?;
    let existing: Option<(String, String, String, u64, String, Option<String>)> = tx
        .query_row(
            "SELECT session_id,prompt,delivery,admitted_seq,state,attachments FROM engine_input WHERE id=?1",
            [&input.input_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let delivery = match input.delivery {
        Delivery::Steer => "steer",
        Delivery::Queue => "queue",
    };
    if let Some((session, prompt, mode, _, _, stored)) = &existing {
        let stored = stored.clone().unwrap_or_else(|| "[]".into());
        if session != &input.session_id
            || prompt != &input.prompt
            || mode != delivery
            || stored != serialized
        {
            return Err(Error::Conflict);
        }
    }
    tx.execute(
        "INSERT OR IGNORE INTO engine_session(id) VALUES(?1)",
        [&input.session_id],
    )?;
    if let Some(root) = root {
        let placement: Option<String> = tx
            .query_row(
                "SELECT root FROM engine_location WHERE session_id=?1",
                [&input.session_id],
                |row| row.get(0),
            )
            .optional()?;
        if placement.is_some_and(|placement| placement != root) {
            return Err(Error::Conflict);
        }
        tx.execute(
            "INSERT OR IGNORE INTO engine_location VALUES(?1,?2)",
            params![input.session_id, root],
        )?;
    }
    if let Some((_, _, _, seq, state, _)) = existing {
        return Ok(Admission {
            input_id: input.input_id.clone(),
            admitted_seq: seq,
            duplicate: true,
            pending: state == "pending",
        });
    }
    let event = append(
        tx,
        &input.session_id,
        "input.admitted",
        json!({"input_id":input.input_id,"delivery":delivery}),
    )?;
    tx.execute(
        "INSERT INTO engine_input(id,session_id,prompt,delivery,state,admitted_seq,attachments) VALUES(?1,?2,?3,?4,'pending',?5,?6)",
        params![
            input.input_id,
            input.session_id,
            input.prompt,
            delivery,
            event.seq,
            serialized
        ],
    )?;
    Ok(Admission {
        input_id: input.input_id.clone(),
        admitted_seq: event.seq,
        duplicate: false,
        pending: true,
    })
}

pub(crate) fn append(
    tx: &Transaction<'_>,
    session: &str,
    kind: &str,
    data: Value,
) -> Result<Event, Error> {
    append_at(tx, session, kind, data, Some(now_ms()))
}

/// Reject a write from a writer whose Session lease was superseded. The check
/// belongs inside the caller's transaction: a claim that arrives concurrently
/// then either precedes the fence (and fails here) or follows the commit.
pub(crate) fn require_lease(
    tx: &Transaction<'_>,
    session: &str,
    lease: &SessionLease,
) -> Result<(), Error> {
    if lease.session != session {
        return Err(Error::Fenced);
    }
    let epoch: Option<i64> = tx
        .query_row(
            "SELECT epoch FROM engine_lease WHERE session_id=?1",
            [session],
            |row| row.get(0),
        )
        .optional()?;
    if epoch != Some(lease.epoch as i64) {
        return Err(Error::Fenced);
    }
    Ok(())
}

pub(crate) fn append_fenced(
    tx: &Transaction<'_>,
    session: &str,
    kind: &str,
    data: Value,
    lease: &SessionLease,
) -> Result<Event, Error> {
    require_lease(tx, session, lease)?;
    append(tx, session, kind, data)
}

fn append_at(
    tx: &Transaction<'_>,
    session: &str,
    kind: &str,
    data: Value,
    recorded_at_ms: Option<u64>,
) -> Result<Event, Error> {
    let seq: u64 = tx.query_row(
        "UPDATE engine_session SET next_seq=next_seq+1 WHERE id=?1 RETURNING next_seq",
        [session],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO engine_event(session_id,seq,kind,data,recorded_at_ms) VALUES(?1,?2,?3,?4,?5)",
        params![
            session,
            seq,
            kind,
            serde_json::to_string(&data)?,
            recorded_at_ms
        ],
    )?;
    Ok(Event {
        session_id: session.into(),
        seq,
        kind: kind.into(),
        data,
        recorded_at_ms,
    })
}

fn project_message(
    tx: &Transaction<'_>,
    session: &str,
    role: &str,
    content: Value,
    checkpoint: Option<&str>,
    anchor: Option<u64>,
) -> Result<Event, Error> {
    project_message_at(
        tx,
        session,
        role,
        content,
        checkpoint,
        anchor,
        Some(now_ms()),
    )
}

fn project_message_at(
    tx: &Transaction<'_>,
    session: &str,
    role: &str,
    content: Value,
    checkpoint: Option<&str>,
    anchor: Option<u64>,
    recorded_at_ms: Option<u64>,
) -> Result<Event, Error> {
    // The anchor binds a committed assistant message to the step that streamed
    // it, so a client can move its live part onto the committed id. Other
    // roles have no anchor and omit the field.
    let payload = match anchor {
        Some(anchor) => {
            json!({"role":role,"content":content,"checkpoint":checkpoint,"anchor_seq":anchor})
        }
        None => json!({"role":role,"content":content,"checkpoint":checkpoint}),
    };
    let event = append_at(tx, session, "message.committed", payload, recorded_at_ms)?;
    tx.execute(
        "INSERT INTO engine_message(session_id,seq,role,content,checkpoint,recorded_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            session,
            event.seq,
            role,
            serde_json::to_string(&content)?,
            checkpoint,
            event.recorded_at_ms
        ],
    )?;
    Ok(event)
}

fn reconcile_tools(tx: &Transaction<'_>, session: &str, run: &str) -> Result<(), Error> {
    crate::question::reconcile(tx, session, run)?;
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
        project_message(tx, session, "user", Value::Array(results), None, None)?;
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

pub(crate) fn projected(
    tx: &Transaction<'_>,
    session: &str,
    cursor: u64,
) -> Result<Vec<Value>, Error> {
    let mut stmt=tx.prepare("SELECT seq,role,content,checkpoint,recorded_at_ms FROM engine_message WHERE session_id=?1 AND seq<=?2 AND reverted=0 ORDER BY seq LIMIT 1001")?;
    let mut rows = stmt.query(params![session, cursor])?;
    let mut messages = Vec::new();
    let mut bytes = 0;
    while let Some(row) = rows.next()? {
        let content: String = row.get(2)?;
        bytes += content.len();
        if bytes > 2 * 1024 * 1024 || messages.len() >= 1000 {
            return Err(Error::Invalid(
                "projection exceeds snapshot/fork limit".into(),
            ));
        }
        let seq = row.get::<_, u64>(0)?;
        let mut message = json!({"seq":seq,"role":row.get::<_,String>(1)?,"content":serde_json::from_str::<Value>(&content)?,"checkpoint":row.get::<_,Option<String>>(3)?,"recorded_at_ms":row.get::<_,Option<u64>>(4)?});
        if let Some((profile, _)) = assistant_profile(tx, session, seq)? {
            message["identity"] = profile;
        }
        messages.push(message);
    }
    Ok(messages)
}

fn assistant_profile(
    tx: &Transaction<'_>,
    session: &str,
    seq: u64,
) -> Result<Option<(Value, Option<u64>)>, Error> {
    let row: Option<(String, Option<u64>)> = tx.query_row(
        "SELECT data,recorded_at_ms FROM engine_event WHERE session_id=?1 AND kind='assistant.identity' AND json_extract(data,'$.assistant_seq')=?2 ORDER BY seq LIMIT 1",
        params![session,seq], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    row.map(|(data, time)| Ok((serde_json::from_str(&data)?, time)))
        .transpose()
}

pub(crate) fn closed_prefix(messages: &[Value]) -> Result<(), Error> {
    let mut pending = std::collections::HashSet::new();
    for message in messages {
        track_tools(&mut pending, &message["content"])?;
    }
    if !pending.is_empty() {
        return Err(Error::Invalid("boundary has unresolved tool calls".into()));
    }
    Ok(())
}

pub(crate) fn track_tools(
    pending: &mut std::collections::HashSet<String>,
    content: &Value,
) -> Result<(), Error> {
    for block in content
        .as_array()
        .ok_or_else(|| Error::Invalid("projected content".into()))?
    {
        match block["type"].as_str() {
            Some("tool_use") => {
                let id = block["id"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool id".into()))?;
                if !pending.insert(id.to_owned()) || pending.len() > 256 {
                    return Err(Error::Invalid(
                        "duplicate or excessive unresolved tool ids".into(),
                    ));
                }
            }
            Some("tool_result") => {
                let id = block["tool_use_id"]
                    .as_str()
                    .ok_or_else(|| Error::Invalid("tool result id".into()))?;
                if !pending.remove(id) {
                    return Err(Error::Invalid("unmatched tool result".into()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

impl Store {
    /// Record one turn's time-to-first-token. Wall-clock values never enter
    /// the event ledger — the blackbox replay pins journal payloads exactly
    /// and cannot reproduce them — so latencies live in this side table and
    /// surface only through `usage_report`.
    pub async fn record_timing(
        &self,
        session: &str,
        run: &str,
        step: u64,
        ttft_ms: u64,
    ) -> Result<(), Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO engine_timing(session_id,run_id,step,ttft_ms) VALUES(?1,?2,?3,?4)",
                params![session, run, step, ttft_ms],
            )?;
            Ok(())
        })
        .await
    }

    /// Wall-clock settle time of one billed turn, recorded when its `usage`
    /// event commits. It lives in the same side table as TTFT so replayed
    /// payloads stay free of wall-clock (ADR-15 recorded-time rule); rows for
    /// turns that predate the column keep a NULL and the projection degrades
    /// instead of fabricating a time.
    pub async fn record_turn_time(
        &self,
        session: &str,
        run: &str,
        step: u64,
        turn_ms: u64,
    ) -> Result<(), Error> {
        let (session, run) = (session.to_owned(), run.to_owned());
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO engine_timing(session_id,run_id,step,ttft_ms,turn_ms) VALUES(?1,?2,?3,0,?4)
                 ON CONFLICT(session_id,run_id,step) DO UPDATE SET turn_ms=excluded.turn_ms",
                params![session, run, step, turn_ms],
            )?;
            Ok(())
        })
        .await
    }

    /// Cache lineage and latency evidence for one session: billed token
    /// totals across every recorded turn, time-to-first-token stats, and the
    /// provider/model that served each turn (roadmap A5). Tokens and lineage
    /// come from the durable `usage` and `provider.started` rows; TTFT comes
    /// from the `engine_timing` side table, never from replayed payloads.
    pub async fn usage_report(&self, session: &str) -> Result<Value, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let mut turns = 0u64;
            let mut partial_turns = 0u64;
            let mut tokens = json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"nonCached":0});
            let mut coverage = json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"nonCached":0});
            let mut requests = 0u64;
            let mut invalid_cache_rows = 0u64;
            let mut changes = std::collections::BTreeMap::<String,u64>::new();
            let mut histories = std::collections::BTreeMap::<String,u64>::new();
            let turn_ms: std::collections::HashMap<(String, String), u64> = {
                let mut stmt = conn.prepare(
                    "SELECT run_id,step,turn_ms FROM engine_timing WHERE session_id=?1 AND turn_ms IS NOT NULL",
                )?;
                let mut rows = stmt.query(params![session])?;
                let mut values = std::collections::HashMap::new();
                while let Some(row) = rows.next()? {
                    values.insert(
                        (row.get::<_, String>(0)?, row.get::<_, u64>(1)?.to_string()),
                        row.get::<_, u64>(2)?,
                    );
                }
                values
            };
            let ttft: Vec<u64> = {
                let mut stmt = conn.prepare(
                    "SELECT ttft_ms FROM engine_timing WHERE session_id=?1 ORDER BY run_id,step",
                )?;
                let mut rows = stmt.query(params![session])?;
                let mut values = Vec::new();
                while let Some(row) = rows.next()? {
                    values.push(row.get::<_, u64>(0)?);
                }
                values
            };
            let mut identity: std::collections::HashMap<(String, String), (String, String)> =
                std::collections::HashMap::new();
            let mut per_identity: std::collections::HashMap<(String, String), u64> =
                std::collections::HashMap::new();
            let mut tool_calls = 0u64;
            let mut tool_failures = 0u64;
            let mut turn_detail: Vec<Value> = Vec::new();
            let mut provider_usage=crate::usage::Totals::default();
            let mut auxiliary_usage=crate::usage::Totals::default();
            let mut auxiliary_detail=Vec::new();
            let mut provider_detail=Vec::new();
            let mut auxiliary_accepted=0u64;
            let mut auxiliary_failed=0u64;
            let mut auxiliary_rejected=0u64;
            let mut role_starts=std::collections::HashMap::<u64,Option<u64>>::new();
            let mut stmt = conn.prepare(
                "SELECT seq,kind,data,recorded_at_ms FROM engine_event WHERE session_id=?1 AND kind IN ('usage','provider.started','provider.request','tool.completed','role.provider.started','role.provider.completed') ORDER BY seq",
            )?;
            let mut rows = stmt.query(params![session])?;
            while let Some(row) = rows.next()? {
                let kind: String = row.get(1)?;
                let data: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
                let key = (
                    data["run_id"].as_str().unwrap_or_default().to_owned(),
                    data["step"].as_u64().unwrap_or_default().to_string(),
                );
                match kind.as_str() {
                    "role.provider.started"=>{role_starts.insert(row.get::<_,u64>(0)?,row.get::<_,Option<u64>>(3)?);}
                    "role.provider.completed"=>{
                        let usage=crate::usage::observed(&data["usage"]);
                        provider_usage.observe(&usage);auxiliary_usage.observe(&usage);
                        auxiliary_accepted+=u64::from(data["accepted"]==true);
                        auxiliary_failed+=u64::from(data["providerSuccess"]!=true);
                        auxiliary_rejected+=u64::from(data["providerSuccess"]==true && data["accepted"]!=true);
                        let duration=data["startedSeq"].as_u64().and_then(|seq|role_starts.get(&seq).copied().flatten()).zip(row.get::<_,Option<u64>>(3)?).and_then(|(start,end)|end.checked_sub(start));
                        let detail=json!({"receiptSeq":row.get::<_,u64>(0)?,"kind":"auxiliary","runID":data["run_id"],"role":data["role"],"path":data["path"],"accepted":data["accepted"],"providerSuccess":data["providerSuccess"],"protocol":data["identity"]["protocol"],"model":data["identity"]["model"],"identitySource":data["identitySource"],"usage":usage,"durationMs":duration,"turnMs":row.get::<_,Option<u64>>(3)?});
                        auxiliary_detail.push(detail.clone());provider_detail.push(detail);
                    }
                    "provider.request" => {
                        requests += 1;
                        let diagnostic = &data["cache_diagnostics"];
                        if let Some(state) = diagnostic["historyState"].as_str() {
                            *histories.entry(state.to_owned()).or_default() += 1;
                        }
                        for reason in diagnostic["changes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                            *changes.entry(reason.to_owned()).or_default() += 1;
                        }
                    }
                    "provider.started" => {
                        if let Some(id) = data["identity"].as_object() {
                            identity.insert(
                                key,
                                (
                                    id.get("protocol").and_then(Value::as_str).unwrap_or_default().to_owned(),
                                    id.get("model").and_then(Value::as_str).unwrap_or_default().to_owned(),
                                ),
                            );
                        }
                    }
                    "tool.completed" => {
                        tool_calls += 1;
                        if data["is_error"].as_bool() == Some(true) {
                            tool_failures += 1;
                        }
                    }
                    _ => {
                        if data["partial"].as_bool() == Some(true) {
                            partial_turns += 1;
                        } else {
                            turns += 1;
                        }
                        let usage = &data["usage"];
                        provider_usage.observe(usage);
                        if usage["inputTokens"].as_u64().is_some_and(|input| {
                            usage["cacheReadInputTokens"].as_u64().unwrap_or(0)
                                .saturating_add(usage["cacheWriteInputTokens"].as_u64().unwrap_or(0)) > input
                        }) {
                            invalid_cache_rows += 1;
                        }
                        for (field, key) in [
                            ("inputTokens", "input"),
                            ("outputTokens", "output"),
                            ("cacheReadInputTokens", "cacheRead"),
                            ("cacheWriteInputTokens", "cacheWrite"),
                            ("nonCachedInputTokens", "nonCached"),
                        ] {
                            if let Some(value) = usage[field].as_u64() {
                                tokens[key] = json!(tokens[key].as_u64().unwrap_or(0) + value);
                                coverage[key] = json!(coverage[key].as_u64().unwrap_or(0) + 1);
                            }
                        }
                        if let Some((provider, model)) = identity.get(&key) {
                            *per_identity
                                .entry((provider.clone(), model.clone()))
                                .or_insert(0) += 1;
                        }
                        {
                            // Per-turn rows keep each turn's own context size so
                            // the product can price tiered rates per turn instead
                            // of against the summed input.
                            let mut detail = json!({
                                "kind":"primary","partial":data["partial"]==true,
                                "observedUsage":crate::usage::observed(usage),
                                "runID": data["run_id"],
                                "step": data["step"],
                                "usage": {
                                    "inputTokens": usage["inputTokens"].as_u64().unwrap_or(0),
                                    "outputTokens": usage["outputTokens"].as_u64().unwrap_or(0),
                                    "reasoningTokens": usage["reasoningTokens"].as_u64().unwrap_or(0),
                                    "cacheReadInputTokens": usage["cacheReadInputTokens"].as_u64().unwrap_or(0),
                                    "cacheWriteInputTokens": usage["cacheWriteInputTokens"].as_u64().unwrap_or(0),
                                    "nonCachedInputTokens": usage["nonCachedInputTokens"].as_u64().unwrap_or(0),
                                },
                            });
                            if let Some((protocol, model)) = identity.get(&key) {
                                detail["protocol"] = json!(protocol);
                                detail["model"] = json!(model);
                            }
                            if let Some(value) = turn_ms.get(&key) {
                                detail["turnMs"] = json!(value);
                            }
                            provider_detail.push(detail.clone());
                            if data["partial"] != true { turn_detail.push(detail); }
                        }
                    }
                }
            }
            let lineage = per_identity
                .into_iter()
                .map(|((protocol, model), served)| json!({"protocol":protocol,"model":model,"turns":served}))
                .collect::<Vec<_>>();
            let ttft_stats = if ttft.is_empty() {
                json!(null)
            } else {
                let sum: u128 = ttft.iter().map(|v| *v as u128).sum();
                json!({
                    "count": ttft.len(),
                    "avg": sum / ttft.len() as u128,
                    "min": ttft.iter().min(),
                    "max": ttft.iter().max(),
                })
            };
            Ok(json!({
                "providerUsage":provider_usage.report(),
                "providerDetail":provider_detail,
                "auxiliary":{"usage":auxiliary_usage.report(),"accepted":auxiliary_accepted,"semanticRejected":auxiliary_rejected,"providerFailed":auxiliary_failed,"turnsDetail":auxiliary_detail},
                "turns": turns,
                "partialTurns": partial_turns,
                "tokens": tokens,
                "cacheDiagnostics": {
                    "observedRequests":requests, "usageObservations":turns + partial_turns,
                    "coverage":coverage, "observedChanges":changes, "historyStates":histories,
                    "invalidBreakdowns":invalid_cache_rows,
                    "serverCacheState":"unknown",
                    "hitRatio": if turns + partial_turns > 0 && invalid_cache_rows == 0
                        && coverage["input"].as_u64() == Some(turns + partial_turns)
                        && coverage["cacheRead"].as_u64() == Some(turns + partial_turns)
                        && tokens["input"].as_u64().unwrap_or(0) > 0 {
                        Some(tokens["cacheRead"].as_f64().unwrap_or(0.0) / tokens["input"].as_f64().unwrap_or(1.0))
                    } else { None },
                },
                "ttftMs": ttft_stats,
                "lineage": lineage,
                "tools": {"calls": tool_calls, "failures": tool_failures},
                "turnsDetail": turn_detail,
            }))
        }).await
    }

    /// Whether the Session exists in the durable ledger — the probe ACP
    /// `session/resume` uses, since resuming creates nothing.
    pub async fn exists(&self, session: &str) -> Result<bool, Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let found: Option<String> = conn
                .query_row(
                    "SELECT id FROM engine_session WHERE id=?1",
                    params![session],
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;
            Ok(found.is_some())
        })
        .await
    }
}
