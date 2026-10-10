use crate::{
    protocol::{Error, Message},
    store::{append, track_tools, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

impl Store {
    /// Explicit host-supplied projection checkpoint. No raw transcript deletion
    /// and no claim that a generated summary preserves task quality.
    pub async fn compact(
        &self,
        session: &str,
        id: &str,
        through: u64,
        summary: String,
    ) -> Result<Value, Error> {
        if id.is_empty() || id.len() > 256 || summary.is_empty() || summary.len() > 32768 {
            return Err(Error::Invalid("invalid compaction checkpoint".into()));
        }
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let existing:Option<(String,u64,String)>=tx.query_row("SELECT session_id,through_seq,summary FROM engine_compaction WHERE id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((owner,cut,text))=existing {if owner!=session||cut!=through||text!=summary{return Err(Error::Conflict);}return Ok(json!({"compaction_id":id,"through_message_seq":through,"duplicate":true}));}
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE session_id=?1 AND state='running')",[&session],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("compaction requires an idle Session".into()));}
            let role:Option<String>=tx.query_row("SELECT role FROM engine_message WHERE session_id=?1 AND seq=?2",params![session,through],|r|r.get(0)).optional()?;
            if role.as_deref()!=Some("assistant"){return Err(Error::Invalid("compaction needs an assistant message boundary".into()));}
            let mut pending=std::collections::HashSet::new();let mut last=None;
            {let mut stmt=tx.prepare("SELECT content FROM engine_message WHERE session_id=?1 AND seq<=?2 ORDER BY seq")?;let mut rows=stmt.query(params![session,through])?;
                while let Some(row)=rows.next()?{let content:Value=serde_json::from_str(&row.get::<_,String>(0)?)?;track_tools(&mut pending,&content)?;last=Some(content);}
            }
            if !pending.is_empty()||!last.is_some_and(|content|content.as_array().is_some_and(|parts|parts.iter().any(|p|p["type"]=="text"&&p["text"].as_str().is_some_and(|s|!s.is_empty())))){return Err(Error::Invalid("compaction cannot cut a tool continuation".into()));}
            let previous:Option<u64>=tx.query_row("SELECT through_seq FROM engine_compaction WHERE session_id=?1 ORDER BY created_seq DESC LIMIT 1",[&session],|r|r.get(0)).optional()?;
            if previous.is_some_and(|previous|through<previous){return Err(Error::Invalid("checkpoint cannot move backwards".into()));}
            append(&tx,&session,crate::events::Lifecycle::PreCompact.name(),json!({"compaction_id":id,"through_message_seq":through}))?;
            let event=append(&tx,&session,"history.compacted",json!({"compaction_id":id,"through_message_seq":through,"summary":summary}))?;
            append(&tx,&session,crate::events::Lifecycle::PostCompact.name(),json!({"compaction_id":id,"through_message_seq":through}))?;
            tx.execute("INSERT INTO engine_compaction VALUES(?1,?2,?3,?4,?5)",params![id,session,through,summary,event.seq])?;tx.commit()?;
            Ok(json!({"compaction_id":id,"through_message_seq":through,"duplicate":false}))
        }).await
    }

    /// Provider history selection is independent of immutable projected history.
    /// Oversized windows fail explicitly rather than silently dropping tools or
    /// opaque reasoning. Automatic summarization is a separate policy/quality step.
    pub async fn selected_history(&self, session: &str) -> Result<Vec<Message>, Error> {
        self.selected_input(session)
            .await
            .map(|(messages, _)| messages)
    }

    pub(crate) async fn selected_input(
        &self,
        session: &str,
    ) -> Result<(Vec<Message>, Value), Error> {
        let session = session.to_owned();
        self.call(move |conn| {
            let tx=conn.transaction()?;
            let checkpoint:Option<(u64,String)>=tx.query_row("SELECT through_seq,summary FROM engine_compaction WHERE session_id=?1 ORDER BY created_seq DESC LIMIT 1",[&session],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let mut selected=Vec::new();let mut bytes=0;
            let through=if let Some((through,summary))=checkpoint {
                let text=format!("<history-summary>\n{summary}\n</history-summary>\nThis summarizes completed history. Do not repeat completed operations or unknown side effects automatically.");
                bytes=text.len();selected.push(Message{role:"user".into(),content:json!([{"type":"text","text":text}]),checkpoint:None});through
            }else{0};
            let mut stmt=tx.prepare("SELECT role,content FROM engine_message WHERE session_id=?1 AND seq>?2 AND reverted=0 ORDER BY seq LIMIT 1001")?;
            let mut rows=stmt.query(params![session,through])?;
            while let Some(row)=rows.next()? {
                let content:String=row.get(1)?;bytes+=content.len();if bytes>2*1024*1024||selected.len()>=1000{return Err(Error::Invalid("selected history exceeds budget; compact at a closed boundary".into()));}
                selected.push(Message{role:row.get(0)?,content:serde_json::from_str(&content)?,checkpoint:None});
            }
            let state=crate::state::projection(&tx,&session,i64::MAX as u64)?;
            Ok((selected,state))
        }).await
    }
}
