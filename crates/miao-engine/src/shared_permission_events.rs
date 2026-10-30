//! Durable request notifications are UI facts, never an execution/grant ticket.
use crate::{
    permission::digest,
    permission_context::Context,
    permission_source_transaction::Origin,
    product_permission_request::{Record, State},
    protocol::Error,
    store::{append, Store},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    PermissionRequests,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub stream: Stream,
    pub authority: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Admitted,
    Resolved,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub seq: u64,
    pub phase: Phase,
    pub record: Record,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub cursor: Cursor,
    pub events: Vec<Event>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct Projection {
    pub cursor: Cursor,
    pub emitted: usize,
    pub has_more: bool,
}

pub(crate) fn initialize_root(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE INDEX IF NOT EXISTS permission_request_event_request ON permission_request_event(request_id,seq)")?;
    Ok(())
}

pub(crate) fn initialize_source(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS engine_root_permission_cursor(authority TEXT NOT NULL,project TEXT NOT NULL,location TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq BETWEEN 0 AND 9007199254740991),PRIMARY KEY(authority,project,location));
        CREATE TABLE IF NOT EXISTS engine_root_permission_event(authority TEXT NOT NULL,seq INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(authority,seq));")?;
    Ok(())
}

impl Context {
    /// Read only notifications for this exact Source database and bound scope.
    /// Consumers must still use a live fenced status/reply before acting.
    pub async fn request_events(
        &self,
        source: &Store,
        after: Option<Cursor>,
        limit: usize,
    ) -> Result<Page, Error> {
        if limit == 0 || limit > 256 {
            return Err(Error::Invalid("invalid shared request event page".into()));
        }
        let context = self.clone();
        let database = source
            .path()
            .to_str()
            .ok_or_else(|| Error::Invalid("invalid permission source path".into()))?
            .to_owned();
        self.project.authority.call(move |connection| {
            let transaction=connection.transaction()?;
            let authority=crate::permission_changefeed::cursor(&transaction)?.authority;
            let watermark:u64=transaction.query_row("SELECT coalesce(max(seq),0) FROM permission_request_event",[],|row|row.get(0))?;
            if after.as_ref().is_some_and(|cursor|cursor.authority!=authority || cursor.seq>watermark || cursor.seq>9_007_199_254_740_991) {
                return Err(Error::Invalid("invalid shared request event cursor".into()));
            }
            let mut events={
                let mut statement=transaction.prepare("SELECT e.seq,e.request_id,e.data,r.owner,r.origin,r.binding,EXISTS(SELECT 1 FROM permission_request_event previous WHERE previous.request_id=e.request_id AND previous.seq<e.seq) FROM permission_request_event e JOIN permission_request r ON r.id=e.request_id WHERE r.project=?1 AND r.location=?2 AND json_extract(r.origin,'$.database')=?3 AND e.seq>?4 AND e.seq<=?5 ORDER BY e.seq LIMIT ?6")?;
                let rows=statement.query_map(params![context.project.project,context.location,database,after.as_ref().map_or(0,|cursor|cursor.seq),watermark,limit+1],|row|Ok((row.get::<_,u64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,bool>(6)?)))?;
                rows.map(|row| {
                    let (seq,id,data,owner,origin,binding,resolved)=row?;
                    let origin:Origin=serde_json::from_str(&origin)?;
                    let record:Record=serde_json::from_str(&data)?;
                    let expected=context.request_binding_for_origin(&transaction,&origin,&owner,&record.source)?;
                    let hash=digest(&serde_json::to_vec(&json!({"binding":binding,"input":record.request}))?);
                    if record.id!=id || record.request.request_id!=id || record.workspace!=context.directory || record.input_hash!=hash || binding!=expected {
                        return Err(Error::Invalid("invalid shared request event binding".into()));
                    }
                    Ok(Event{seq,phase:if resolved {Phase::Resolved} else {Phase::Admitted},record})
                }).collect::<Result<Vec<_>,Error>>()?
            };
            let has_more=events.len()>limit;
            events.truncate(limit);
            let seq=if has_more {events.last().unwrap().seq} else {watermark};
            transaction.commit()?;
            Ok(Page{cursor:Cursor{stream:Stream::PermissionRequests,authority,seq},events,has_more})
        }).await
    }

    /// Project the Root journal into Session UI events exactly once. The two
    /// databases commit independently; replay repairs a lost projection response.
    pub async fn project_request_events(
        &self,
        source: &Store,
        limit: usize,
    ) -> Result<Projection, Error> {
        let authority = self.snapshot().await?.project.authority;
        let project = self.project.project.clone();
        let location = self.location.clone();
        let key_authority = authority.clone();
        let key_project = project.clone();
        let key_location = location.clone();
        let seq=source.call(move |connection| {
            Ok(connection.query_row("SELECT seq FROM engine_root_permission_cursor WHERE authority=?1 AND project=?2 AND location=?3",params![key_authority,key_project,key_location],|row|row.get::<_,u64>(0)).optional()?.unwrap_or(0))
        }).await?;
        let page = self
            .request_events(
                source,
                Some(Cursor {
                    stream: Stream::PermissionRequests,
                    authority: authority.clone(),
                    seq,
                }),
                limit,
            )
            .await?;
        let has_more = page.has_more;
        source.call(move |connection| {
            let transaction=crate::store::write_tx(connection)?;
            let current=transaction.query_row("SELECT seq FROM engine_root_permission_cursor WHERE authority=?1 AND project=?2 AND location=?3",params![authority,project,location],|row|row.get::<_,u64>(0)).optional()?.unwrap_or(0);
            let mut emitted=0;
            for event in &page.events {
                if event.seq<=current {continue;}
                let hash=digest(&serde_json::to_vec(event)?);
                let previous=transaction.query_row("SELECT digest FROM engine_root_permission_event WHERE authority=?1 AND seq=?2",params![authority,event.seq],|row|row.get::<_,String>(0)).optional()?;
                if let Some(previous)=previous {
                    if previous!=hash {return Err(Error::Invalid("conflicting shared request event projection".into()));}
                    continue;
                }
                let kind=match (&event.phase,event.record.state) {
                    (Phase::Admitted,State::Pending)=>Some("product.permission.requested"),
                    (Phase::Admitted,_)=>None,
                    (Phase::Resolved,_)=>Some("product.permission.resolved"),
                };
                if let Some(kind)=kind {
                    append(&transaction,&event.record.source.session_id,kind,serde_json::to_value(&event.record)?)?;
                    emitted+=1;
                }
                transaction.execute("INSERT INTO engine_root_permission_event(authority,seq,digest) VALUES(?1,?2,?3)",params![authority,event.seq,hash])?;
            }
            let seq=current.max(page.cursor.seq);
            transaction.execute("INSERT INTO engine_root_permission_cursor(authority,project,location,seq) VALUES(?1,?2,?3,?4) ON CONFLICT(authority,project,location) DO UPDATE SET seq=max(engine_root_permission_cursor.seq,excluded.seq)",params![authority,project,location,seq])?;
            transaction.commit()?;
            Ok(Projection{cursor:Cursor{stream:Stream::PermissionRequests,authority,seq},emitted,has_more})
        }).await
    }
}
