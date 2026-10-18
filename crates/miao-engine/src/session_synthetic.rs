//! Injected context is a history fact, not an operator inbox item.
use crate::{
    protocol::Error,
    store::{append, write_tx, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

impl Store {
    pub async fn inject(
        &self,
        session: &str,
        id: &str,
        text: &str,
        source: &str,
    ) -> Result<Value, Error> {
        if id.is_empty()
            || id.len() > 256
            || text.is_empty()
            || text.len() > 1024 * 1024
            || source.is_empty()
            || source.len() > 256
            || source.chars().any(char::is_control)
        {
            return Err(Error::Invalid("invalid synthetic context".into()));
        }
        let (session, id, text, source) = (
            session.to_owned(),
            id.to_owned(),
            text.to_owned(),
            source.to_owned(),
        );
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",[&session],|row|row.get(0))?;
            if !exists { return Err(Error::Invalid("Session does not exist".into())); }
            let existing:Option<(u64,String)>=tx.query_row("SELECT seq,data FROM engine_event WHERE session_id=?1 AND kind='message.synthetic' AND json_extract(data,'$.input_id')=?2 ORDER BY seq LIMIT 1",params![session,id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
            if let Some((seq,data))=existing {
                let data:Value=serde_json::from_str(&data)?;
                if data["text"]!=text || data["source"]!=source {return Err(Error::Conflict);}
                return Ok(json!({"seq":seq,"duplicate":true}));
            }
            let event=append(&tx,&session,"message.synthetic",json!({"input_id":id,"text":text,"source":source}))?;
            // The provider sees explicitly attributed context; the transcript
            // projects the synthetic event, never an operator prompt.
            let content=json!([{"type":"text","text":format!("<injected-context source={}>\n{}\n</injected-context>",serde_json::to_string(&source)?,text)}]);
            tx.execute("INSERT INTO engine_message(session_id,seq,role,content,recorded_at_ms) VALUES(?1,?2,'user',?3,?4)",params![session,event.seq,serde_json::to_string(&content)?,event.recorded_at_ms])?;
            tx.commit()?;
            Ok(json!({"seq":event.seq,"duplicate":false}))
        }).await
    }
}
