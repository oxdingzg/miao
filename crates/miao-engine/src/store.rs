use crate::protocol::{Admission, Delivery, Error, Event, Input, Message};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{fs::OpenOptions, path::Path};
use tokio::sync::{mpsc, oneshot};

type Work = Box<dyn FnOnce(&mut Connection) + Send>;

/// One dedicated SQLite worker owns both the connection and store lease. Async
/// callers never block a Tokio worker on SQLite locks or filesystem operations.
#[derive(Clone)]
pub struct Store {
    work: mpsc::Sender<Work>,
}

impl Store {
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
                conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
                    CREATE TABLE IF NOT EXISTS engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE IF NOT EXISTS engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS engine_message(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(session_id,seq));
                    CREATE TABLE IF NOT EXISTS engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), state TEXT NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS engine_active_run ON engine_run(session_id) WHERE state='running';
                    CREATE TABLE IF NOT EXISTS engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_run(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL);")?;
                Ok((conn, lease))
            })();
            match opened {
                Ok((mut conn, _lease)) => {
                    if ready.send(Ok(())).is_err() {
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
        started.await.map_err(|_| Error::Closed)??;
        Ok(Self { work })
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
        if input.session_id.is_empty() || input.input_id.is_empty() || input.prompt.is_empty() {
            return Err(Error::Invalid(
                "session_id, input_id and prompt must be nonempty".into(),
            ));
        }
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let existing: Option<(String, String, String, u64)> = tx
                .query_row(
                    "SELECT session_id,prompt,delivery,admitted_seq FROM engine_input WHERE id=?1",
                    [&input.input_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            let delivery = match input.delivery {
                Delivery::Steer => "steer",
                Delivery::Queue => "queue",
            };
            if let Some((session, prompt, mode, seq)) = existing {
                if session != input.session_id || prompt != input.prompt || mode != delivery {
                    return Err(Error::Conflict);
                }
                return Ok(Admission {
                    input_id: input.input_id,
                    admitted_seq: seq,
                    duplicate: true,
                });
            }
            tx.execute(
                "INSERT OR IGNORE INTO engine_session(id) VALUES(?1)",
                [&input.session_id],
            )?;
            let event = append(
                &tx,
                &input.session_id,
                "input.admitted",
                json!({"input_id":input.input_id,"delivery":delivery}),
            )?;
            tx.execute(
                "INSERT INTO engine_input VALUES(?1,?2,?3,?4,'pending',?5)",
                params![
                    input.input_id,
                    input.session_id,
                    input.prompt,
                    delivery,
                    event.seq
                ],
            )?;
            tx.commit()?;
            Ok(Admission {
                input_id: input.input_id,
                admitted_seq: event.seq,
                duplicate: false,
            })
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
        self.call(|conn| {
            let tx = conn.transaction()?;
            let runs: Vec<(String, String)> = {
                let mut stmt =
                    tx.prepare("SELECT id,session_id FROM engine_run WHERE state='running'")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<Result<_, _>>()?
            };
            let mut events = Vec::new();
            for (run, session) in runs {
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
