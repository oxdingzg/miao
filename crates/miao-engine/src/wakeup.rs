use crate::{
    approval::now_ms,
    protocol::{Admission, Delivery, Error, Input as Prompt},
    store::{admit_input, append, Store},
    tools::ToolError,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub prompt: String,
    #[serde(rename = "delaySeconds")]
    pub delay_seconds: u64,
    #[serde(default = "queue")]
    pub delivery: Delivery,
}
fn queue() -> Delivery {
    Delivery::Queue
}
impl Input {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if input.prompt.trim().is_empty()
            || input.prompt.len() > 8192
            || !(60..=3600).contains(&input.delay_seconds)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(input)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub timer_id: String,
}
impl Selector {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let selector: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if selector.timer_id.is_empty()
            || selector.timer_id.len() > 64
            || !selector
                .timer_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(selector)
    }
}
impl Store {
    pub(crate) async fn create_wakeup(
        &self,
        session: &str,
        run: &str,
        call: &str,
        location: &str,
        input: Input,
    ) -> Result<Value, Error> {
        let (session, run, call, location) = (
            session.to_owned(),
            run.to_owned(),
            call.to_owned(),
            location.to_owned(),
        );
        let input = serde_json::to_value(input)?;
        self.call(move|conn|{
            let tx=conn.transaction()?;let key=format!("{run}/{call}");
            let previous:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='wakeup.scheduled' AND json_extract(data,'$.request_key')=?2 ORDER BY seq DESC LIMIT 1",params![session,key],|row|row.get(0)).optional()?;
            if let Some(previous)=previous {
                let mut previous:Value=serde_json::from_str(&previous)?;
                if previous["input"]!=input||previous["location"]!=location{return Err(Error::Conflict);}
                let id=previous["timer_id"].as_str().ok_or_else(||Error::Invalid("timer id missing".into()))?;
                if let Some(resolved)=resolution(&tx,&session,id)?{previous["state"]=resolved["state"].clone();}
                previous["duplicate"]=json!(true);return Ok(previous);
            }
            let original:Option<String>=tx.query_row("SELECT t.input FROM engine_tool t JOIN engine_run r ON r.id=t.run_id WHERE t.id=?1 AND t.name='schedule_wakeup' AND t.state='dispatched' AND r.session_id=?2 AND r.state='running'",params![key,session],|row|row.get(0)).optional()?;
            let original:Value=serde_json::from_str(&original.ok_or_else(||Error::Invalid("wakeup requires its dispatched intent".into()))?)?;
            let normalized=Input::parse(original["input"].clone()).map_err(|_|Error::Invalid("invalid wakeup intent".into()))?;
            if serde_json::to_value(normalized)?!=input{return Err(Error::Conflict);}
            let data=json!({"timer_id":uuid::Uuid::new_v4().to_string(),"request_key":key,"location":location,"input":input,"due_at_ms":now_ms().saturating_add(input["delaySeconds"].as_u64().unwrap_or(0)*1000),"state":"scheduled"});
            append(&tx,&session,"wakeup.scheduled",data.clone())?;tx.commit()?;Ok(data)
        }).await
    }
    /// Firing and durable prompt admission are one atomic commit. This does not
    /// execute a model; the process-owned timer schedules only an advisory wake.
    pub(crate) async fn fire_wakeup(
        &self,
        session: &str,
        id: &str,
    ) -> Result<Option<Admission>, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move|conn|{
            let tx=conn.transaction()?;
            if resolution(&tx,&session,&id)?.is_some(){return Ok(None);}
            let data:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='wakeup.scheduled' AND json_extract(data,'$.timer_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
            let data:Value=serde_json::from_str(&data.ok_or_else(||Error::Invalid("wakeup not found in this Session".into()))?)?;
            let input=Input::parse(data["input"].clone()).map_err(|_|Error::Invalid("invalid wakeup input".into()))?;
            let prompt=Prompt{session_id:session.clone(),input_id:format!("wakeup/{id}"),prompt:input.prompt,delivery:input.delivery};
            let location=data["location"].as_str().ok_or_else(||Error::Invalid("timer Location missing".into()))?;
            let admitted=admit_input(&tx,&prompt,Some(location))?;
            append(&tx,&session,"wakeup.resolved",json!({"timer_id":id,"state":"fired","input_id":admitted.input_id,"admitted_seq":admitted.admitted_seq}))?;tx.commit()?;Ok(Some(admitted))
        }).await
    }
    pub(crate) async fn close_wakeup(
        &self,
        session: &str,
        id: &str,
        state: &str,
    ) -> Result<bool, Error> {
        if !["cancelled", "interrupted", "failed"].contains(&state) {
            return Err(Error::Invalid("invalid timer terminal state".into()));
        }
        let (session, id, state) = (session.to_owned(), id.to_owned(), state.to_owned());
        self.call(move|conn|{
            let tx=conn.transaction()?;
            if resolution(&tx,&session,&id)?.is_some(){return Ok(false);}
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_event WHERE session_id=?1 AND kind='wakeup.scheduled' AND json_extract(data,'$.timer_id')=?2)",params![session,id],|row|row.get(0))?;
            if !exists{return Ok(false);}
            append(&tx,&session,"wakeup.resolved",json!({"timer_id":id,"state":state}))?;tx.commit()?;Ok(true)
        }).await
    }
    pub async fn wakeups(&self, session: &str) -> Result<Vec<Value>, Error> {
        let session = session.to_owned();
        self.call(move|conn|{
            let mut stmt=conn.prepare("SELECT data FROM engine_event WHERE session_id=?1 AND kind='wakeup.scheduled' ORDER BY seq DESC LIMIT 100")?;
            let rows=stmt.query_map([&session],|row|row.get::<_,String>(0))?;
            rows.map(|row|{let mut data:Value=serde_json::from_str(&row?)?;let id=data["timer_id"].as_str().ok_or_else(||Error::Invalid("timer id missing".into()))?;if let Some(resolved)=resolution(conn,&session,id)?{data["state"]=resolved["state"].clone();data["result"]=resolved;}Ok(data)}).collect()
        }).await
    }
    pub async fn recover_wakeups(&self) -> Result<(), Error> {
        self.call(move|conn|{
            let tx=conn.transaction()?;
            let timers={let mut stmt=tx.prepare("SELECT q.session_id,q.data FROM engine_event q WHERE q.kind='wakeup.scheduled' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='wakeup.resolved' AND json_extract(r.data,'$.timer_id')=json_extract(q.data,'$.timer_id')) LIMIT 65")?;let rows=stmt.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?;rows.collect::<Result<Vec<_>,_>>()?};
            if timers.len()>64{return Err(Error::Invalid("wakeup recovery budget exceeded".into()));}
            for (session,data) in timers{let data:Value=serde_json::from_str(&data)?;append(&tx,&session,"wakeup.resolved",json!({"timer_id":data["timer_id"],"state":"interrupted","recovered":true}))?;}
            tx.commit()?;Ok(())
        }).await
    }
}
fn resolution(conn: &Connection, session: &str, id: &str) -> Result<Option<Value>, Error> {
    let data:Option<String>=conn.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='wakeup.resolved' AND json_extract(data,'$.timer_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
    data.map(|data| serde_json::from_str(&data).map_err(Error::from))
        .transpose()
}

pub(crate) fn pending(conn: &Connection, session: &str) -> Result<Vec<Value>, Error> {
    let mut stmt=conn.prepare("SELECT q.data FROM engine_event q WHERE q.session_id=?1 AND q.kind='wakeup.scheduled' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='wakeup.resolved' AND json_extract(r.data,'$.timer_id')=json_extract(q.data,'$.timer_id')) ORDER BY q.seq DESC LIMIT 65")?;
    let rows = stmt.query_map([session], |row| row.get::<_, String>(0))?;
    let pending = rows
        .map(|row| serde_json::from_str(&row?).map_err(Error::from))
        .collect::<Result<Vec<Value>, Error>>()?;
    if pending.len() > 64 {
        return Err(Error::Invalid("pending timer budget exceeded".into()));
    }
    Ok(pending)
}
