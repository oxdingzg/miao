use crate::{
    approval::now_ms,
    protocol::{Admission, Delivery, Error, Input as Prompt},
    store::{admit_input, append, Store},
    tools::ToolError,
};
use chrono::{DateTime, Local};
use croner::Cron;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::str::FromStr;

pub const LIFETIME_MS: u64 = 7 * 24 * 60 * 60 * 1000;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub prompt: String,
    pub cron: String,
    #[serde(default = "yes")]
    pub recurring: bool,
    #[serde(default = "queue")]
    pub delivery: Delivery,
}
fn yes() -> bool {
    true
}
fn queue() -> Delivery {
    Delivery::Queue
}
impl Input {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let mut input: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if input.prompt.trim().is_empty()
            || input.prompt.len() > 8192
            || input.cron.len() > 256
            || input.cron.split_whitespace().count() != 5
            || !input.cron.bytes().all(|byte| {
                byte.is_ascii_digit() || matches!(byte, b'*' | b',' | b'-' | b'/' | b' ' | b'\t')
            })
        {
            return Err(ToolError::InvalidInput);
        }
        input.cron = input.cron.split_whitespace().collect::<Vec<_>>().join(" ");
        input.pattern()?;
        Ok(input)
    }
    pub fn pattern(&self) -> Result<Cron, ToolError> {
        Cron::from_str(&self.cron).map_err(|_| ToolError::InvalidInput)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub id: String,
}
impl Selector {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let selector: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if selector.id.is_empty()
            || selector.id.len() > 64
            || !selector
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(selector)
    }
}
/// Calendar search is off the Tokio worker; the returned occurrence is still
/// bounded by the process-owned seven-day lifetime before admission is possible.
pub(crate) async fn next(
    pattern: String,
    after: DateTime<Local>,
) -> Result<DateTime<Local>, Error> {
    tokio::task::spawn_blocking(move || {
        Cron::from_str(&pattern)
            .map_err(|_| Error::Invalid("invalid cron pattern".into()))?
            .find_next_occurrence(&after, false)
            .map_err(|_| Error::Invalid("cron has no next occurrence".into()))
    })
    .await
    .map_err(|_| Error::Invalid("cron calendar worker failed".into()))?
}
impl Store {
    pub(crate) async fn create_cron(
        &self,
        session: &str,
        run: &str,
        call: &str,
        location: &str,
        input: Input,
        window: std::ops::Range<u64>,
    ) -> Result<Value, Error> {
        if window.start >= window.end || window.end.saturating_sub(now_ms()) > LIFETIME_MS {
            return Err(Error::Invalid(
                "cron has no occurrence within its lifetime".into(),
            ));
        }
        let (session, run, call, location) = (
            session.to_owned(),
            run.to_owned(),
            call.to_owned(),
            location.to_owned(),
        );
        let input = serde_json::to_value(input)?;
        self.call(move|conn|{
            let tx=conn.transaction()?;let key=format!("{run}/{call}");
            let previous:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='cron.scheduled' AND json_extract(data,'$.request_key')=?2 ORDER BY seq DESC LIMIT 1",params![session,key],|row|row.get(0)).optional()?;
            if let Some(previous)=previous {
                let mut previous:Value=serde_json::from_str(&previous)?;
                if previous["input"]!=input||previous["location"]!=location{return Err(Error::Conflict);}
                let id=previous["cron_id"].as_str().ok_or_else(||Error::Invalid("cron id missing".into()))?;
                if let Some(resolved)=resolution(&tx,&session,id)?{previous["state"]=resolved["state"].clone();}
                previous["duplicate"]=json!(true);return Ok(previous);
            }
            let original:Option<String>=tx.query_row("SELECT t.input FROM engine_tool t JOIN engine_run r ON r.id=t.run_id WHERE t.id=?1 AND t.name='cron_create' AND t.state='dispatched' AND r.session_id=?2 AND r.state='running'",params![key,session],|row|row.get(0)).optional()?;
            let original:Value=serde_json::from_str(&original.ok_or_else(||Error::Invalid("cron requires its dispatched intent".into()))?)?;
            if serde_json::to_value(Input::parse(original["input"].clone()).map_err(|_|Error::Invalid("invalid cron intent".into()))?)?!=input{return Err(Error::Conflict);}
            let data=json!({"cron_id":uuid::Uuid::new_v4().to_string(),"request_key":key,"location":location,"input":input,"first_occurrence_ms":window.start,"expires_at_ms":window.end,"timezone":"system_local","state":"scheduled"});
            append(&tx,&session,"cron.scheduled",data.clone())?;tx.commit()?;Ok(data)
        }).await
    }
    /// Every occurrence has a stable input ID. Pending occurrences coalesce;
    /// skipped ticks remain auditable and do not accumulate an unbounded inbox.
    pub(crate) async fn fire_cron(
        &self,
        session: &str,
        id: &str,
        occurrence: u64,
    ) -> Result<Option<Admission>, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move|conn|{
            let tx=conn.transaction()?;
            if resolution(&tx,&session,&id)?.is_some(){return Ok(None);}
            let original:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='cron.scheduled' AND json_extract(data,'$.cron_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
            let original:Value=serde_json::from_str(&original.ok_or_else(||Error::Invalid("cron not found in this Session".into()))?)?;
            if occurrence<original["first_occurrence_ms"].as_u64().unwrap_or(u64::MAX)||occurrence>=original["expires_at_ms"].as_u64().unwrap_or(0){return Err(Error::Invalid("cron occurrence is outside lifetime".into()));}
            let seen:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_event WHERE session_id=?1 AND kind IN ('cron.fired','cron.skipped') AND json_extract(data,'$.cron_id')=?2 AND json_extract(data,'$.occurrence_ms')=?3)",params![session,id,occurrence],|row|row.get(0))?;
            if seen{return Ok(None);}
            let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_input WHERE session_id=?1 AND state='pending' AND id GLOB ?2)",params![session,format!("cron/{id}/*")],|row|row.get(0))?;
            if pending{append(&tx,&session,"cron.skipped",json!({"cron_id":id,"occurrence_ms":occurrence,"reason":"prior_input_pending"}))?;tx.commit()?;return Ok(None);}
            let input=Input::parse(original["input"].clone()).map_err(|_|Error::Invalid("invalid cron input".into()))?;
            let prompt=Prompt{session_id:session.clone(),input_id:format!("cron/{id}/{occurrence}"),prompt:input.prompt,delivery:input.delivery};
            let location=original["location"].as_str().ok_or_else(||Error::Invalid("cron Location missing".into()))?;
            let admitted=admit_input(&tx,&prompt,Some(location))?;
            append(&tx,&session,"cron.fired",json!({"cron_id":id,"occurrence_ms":occurrence,"input_id":admitted.input_id,"admitted_seq":admitted.admitted_seq}))?;
            if !input.recurring{append(&tx,&session,"cron.resolved",json!({"cron_id":id,"state":"completed"}))?;}
            tx.commit()?;Ok(Some(admitted))
        }).await
    }
    pub(crate) async fn close_cron(
        &self,
        session: &str,
        id: &str,
        state: &str,
    ) -> Result<bool, Error> {
        if !["cancelled", "expired", "interrupted", "failed"].contains(&state) {
            return Err(Error::Invalid("invalid cron terminal state".into()));
        }
        let (session, id, state) = (session.to_owned(), id.to_owned(), state.to_owned());
        self.call(move|conn|{
            let tx=conn.transaction()?;
            if resolution(&tx,&session,&id)?.is_some(){return Ok(false);}
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_event WHERE session_id=?1 AND kind='cron.scheduled' AND json_extract(data,'$.cron_id')=?2)",params![session,id],|row|row.get(0))?;
            if !exists{return Ok(false);}
            append(&tx,&session,"cron.resolved",json!({"cron_id":id,"state":state}))?;tx.commit()?;Ok(true)
        }).await
    }
    pub async fn crons(&self, session: &str) -> Result<Vec<Value>, Error> {
        let session = session.to_owned();
        self.call(move|conn|{
            let mut stmt=conn.prepare("SELECT data FROM engine_event WHERE session_id=?1 AND kind='cron.scheduled' ORDER BY seq DESC LIMIT 100")?;let rows=stmt.query_map([&session],|row|row.get::<_,String>(0))?;
            rows.map(|row|{let mut data:Value=serde_json::from_str(&row?)?;let id=data["cron_id"].as_str().ok_or_else(||Error::Invalid("cron id missing".into()))?;
                let next:Option<String>=conn.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='cron.next' AND json_extract(data,'$.cron_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
                let counts:(u64,u64)=conn.query_row("SELECT COALESCE(sum(kind='cron.fired'),0),COALESCE(sum(kind='cron.skipped'),0) FROM engine_event WHERE session_id=?1 AND kind IN ('cron.fired','cron.skipped') AND json_extract(data,'$.cron_id')=?2",params![session,id],|row|Ok((row.get(0)?,row.get(1)?)))?;
                let resolved=resolution(conn,&session,id)?;data["fired_count"]=json!(counts.0);data["skipped_count"]=json!(counts.1);data["next_occurrence_ms"]=next.map(|value|serde_json::from_str::<Value>(&value)).transpose()?.map(|value|value["next_occurrence_ms"].clone()).unwrap_or_else(||data["first_occurrence_ms"].clone());
                if let Some(resolved)=resolved{data["state"]=resolved["state"].clone();data["next_occurrence_ms"]=Value::Null;}Ok(data)
            }).collect()
        }).await
    }
    pub async fn recover_crons(&self) -> Result<(), Error> {
        self.call(move|conn|{let tx=conn.transaction()?;
            let crons={let mut stmt=tx.prepare("SELECT q.session_id,q.data FROM engine_event q WHERE q.kind='cron.scheduled' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='cron.resolved' AND json_extract(r.data,'$.cron_id')=json_extract(q.data,'$.cron_id')) LIMIT 65")?;let rows=stmt.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?;rows.collect::<Result<Vec<_>,_>>()?};
            if crons.len()>64{return Err(Error::Invalid("cron recovery budget exceeded".into()));}
            for (session,data) in crons{let data:Value=serde_json::from_str(&data)?;append(&tx,&session,"cron.resolved",json!({"cron_id":data["cron_id"],"state":"interrupted","recovered":true}))?;}tx.commit()?;Ok(())
        }).await
    }
}
fn resolution(conn: &Connection, session: &str, id: &str) -> Result<Option<Value>, Error> {
    let data:Option<String>=conn.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='cron.resolved' AND json_extract(data,'$.cron_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
    data.map(|data| serde_json::from_str(&data).map_err(Error::from))
        .transpose()
}
pub(crate) fn pending(conn: &Connection, session: &str) -> Result<Vec<Value>, Error> {
    let mut stmt=conn.prepare("SELECT q.data FROM engine_event q WHERE q.session_id=?1 AND q.kind='cron.scheduled' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='cron.resolved' AND json_extract(r.data,'$.cron_id')=json_extract(q.data,'$.cron_id')) ORDER BY q.seq DESC LIMIT 65")?;
    let rows = stmt.query_map([session], |row| row.get::<_, String>(0))?;
    let pending = rows
        .map(|row| serde_json::from_str(&row?).map_err(Error::from))
        .collect::<Result<Vec<Value>, Error>>()?;
    if pending.len() > 64 {
        return Err(Error::Invalid("pending cron budget exceeded".into()));
    }
    Ok(pending)
}
