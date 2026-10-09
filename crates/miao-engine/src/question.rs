use crate::{
    approval::now_ms,
    permission::input_digest,
    protocol::Error,
    store::{append, Store},
    tools::ToolError,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub label: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub question: String,
    #[serde(default)]
    pub header: String,
    pub options: Vec<Choice>,
    #[serde(default, rename = "multiSelect")]
    pub multi_select: bool,
    #[serde(default = "yes")]
    pub custom: bool,
}
fn yes() -> bool {
    true
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub questions: Vec<Question>,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
}
fn timeout() -> u64 {
    60000
}
impl Input {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(value).map_err(|_| ToolError::InvalidInput)?;
        if input.questions.is_empty()
            || input.questions.len() > 4
            || !(1..=600000).contains(&input.timeout_ms)
        {
            return Err(ToolError::InvalidInput);
        }
        for question in &input.questions {
            let mut labels = std::collections::HashSet::new();
            if question.question.trim().is_empty()
                || question.question.len() > 4096
                || question.header.chars().count() > 12
                || question.options.len() < 2
                || question.options.len() > 4
                || question.options.iter().any(|option| {
                    option.label.trim().is_empty()
                        || option.label.len() > 256
                        || option.description.len() > 1024
                        || !labels.insert(&option.label)
                })
            {
                return Err(ToolError::InvalidInput);
            }
        }
        if serde_json::to_vec(&input)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > 32768
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(input)
    }
    fn accepts(&self, answers: &[Vec<String>]) -> bool {
        answers.len() == self.questions.len()
            && self
                .questions
                .iter()
                .zip(answers)
                .all(|(question, answers)| {
                    let mut seen = std::collections::HashSet::new();
                    !answers.is_empty()
                        && (question.multi_select || answers.len() == 1)
                        && answers.len() <= 16
                        && answers.iter().all(|answer| {
                            !answer.trim().is_empty()
                                && answer.len() <= 2048
                                && seen.insert(answer)
                                && (question.custom
                                    || question
                                        .options
                                        .iter()
                                        .any(|option| option.label == *answer))
                        })
                })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub question_id: String,
    pub input_hash: String,
    pub answers: Vec<Vec<String>>,
}
impl Store {
    pub(crate) async fn request_question(
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
        let hash = input_digest(&location, "question", "@session/question", &input)?;
        self.call(move|conn|{
            let tx=conn.transaction()?;
            let key=format!("{run}/{call}");
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_tool t JOIN engine_run r ON t.run_id=r.id WHERE t.id=?1 AND t.name='question' AND t.state='dispatched' AND r.id=?2 AND r.session_id=?3 AND r.state='running')",params![key,run,session],|row|row.get(0))?;
            if !active{return Err(Error::Invalid("question has no active dispatched intent".into()));}
            let data=json!({"question_id":key,"run_id":run,"call_id":call,"location":location,"input_hash":hash,"input":input,"expires_at_ms":now_ms().saturating_add(input["timeout_ms"].as_u64().unwrap_or(60000))});
            append(&tx,&session,"question.requested",data.clone())?;tx.commit()?;Ok(data)
        }).await
    }
    pub async fn questions(&self, session: &str) -> Result<Vec<Value>, Error> {
        let session = session.to_owned();
        self.call(move |conn| pending(conn, &session)).await
    }
    pub(crate) async fn question_resolution(
        &self,
        session: &str,
        id: &str,
    ) -> Result<Option<Value>, Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| resolution(conn, &session, &id)).await
    }
    pub async fn answer_question(&self, session: &str, answer: Answer) -> Result<(), Error> {
        if answer.question_id.is_empty()
            || answer.question_id.len() > 512
            || answer.input_hash.len() != 64
            || serde_json::to_vec(&answer)?.len() > 32768
        {
            return Err(Error::Invalid("invalid question answer budget".into()));
        }
        let session = session.to_owned();
        self.call(move|conn|{
            let tx=conn.transaction()?;
            let data:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='question.requested' AND json_extract(data,'$.question_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,answer.question_id],|row|row.get(0)).optional()?;
            let data:Value=serde_json::from_str(&data.ok_or_else(||Error::Invalid("question not found in this Session".into()))?)?;
            if data["input_hash"]!=answer.input_hash{return Err(Error::Invalid("question input binding mismatch".into()));}
            if let Some(resolved)=resolution(&tx,&session,&answer.question_id)? {
                if resolved["state"]=="answered"&&resolved["answers"]==json!(answer.answers){return Ok(());}
                return Err(Error::Invalid("question is already resolved".into()));
            }
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE id=?1 AND session_id=?2 AND state='running')",params![data["run_id"].as_str(),session],|row|row.get(0))?;
            if !active{return Err(Error::Invalid("question run is no longer active".into()));}
            if now_ms()>=data["expires_at_ms"].as_u64().unwrap_or(0){
                append(&tx,&session,"question.resolved",json!({"question_id":answer.question_id,"state":"expired"}))?;tx.commit()?;return Err(Error::Invalid("question has expired".into()));
            }
            let input=Input::parse(data["input"].clone()).map_err(|_|Error::Invalid("invalid question input".into()))?;
            if !input.accepts(&answer.answers){return Err(Error::Invalid("answer does not match question choices".into()));}
            append(&tx,&session,"question.resolved",json!({"question_id":answer.question_id,"state":"answered","answers":answer.answers}))?;tx.commit()?;Ok(())
        }).await
    }
    pub async fn recover_questions(&self) -> Result<(), Error> {
        self.call(move|conn|{
            let tx=conn.transaction()?;
            let requests={
                let mut stmt=tx.prepare("SELECT q.session_id,q.data FROM engine_event q WHERE q.kind='question.requested' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='question.resolved' AND json_extract(r.data,'$.question_id')=json_extract(q.data,'$.question_id')) LIMIT 257")?;
                let rows=stmt.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?;rows.collect::<Result<Vec<_>,_>>()?
            };
            if requests.len()>256{return Err(Error::Invalid("question recovery budget exceeded".into()));}
            for (session,data) in requests {
                let data:Value=serde_json::from_str(&data)?;
                append(&tx,&session,"question.resolved",json!({"question_id":data["question_id"],"state":"cancelled","recovered":true}))?;
            }
            tx.commit()?;Ok(())
        }).await
    }
    pub(crate) async fn expire_question(&self, session: &str, id: &str) -> Result<(), Error> {
        let (session, id) = (session.to_owned(), id.to_owned());
        self.call(move |conn| {
            let tx = conn.transaction()?;
            if resolution(&tx, &session, &id)?.is_none() {
                append(
                    &tx,
                    &session,
                    "question.resolved",
                    json!({"question_id":id,"state":"expired"}),
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
}
fn resolution(conn: &Connection, session: &str, id: &str) -> Result<Option<Value>, Error> {
    let value:Option<String>=conn.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='question.resolved' AND json_extract(data,'$.question_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,id],|row|row.get(0)).optional()?;
    value
        .map(|data| serde_json::from_str(&data).map_err(Error::from))
        .transpose()
}
pub(crate) fn pending(conn: &Connection, session: &str) -> Result<Vec<Value>, Error> {
    let mut stmt=conn.prepare("SELECT data FROM engine_event q WHERE q.session_id=?1 AND q.kind='question.requested' AND NOT EXISTS(SELECT 1 FROM engine_event r WHERE r.session_id=q.session_id AND r.kind='question.resolved' AND json_extract(r.data,'$.question_id')=json_extract(q.data,'$.question_id')) ORDER BY q.seq DESC LIMIT 65")?;
    let rows = stmt.query_map([session], |row| row.get::<_, String>(0))?;
    let questions = rows
        .map(|row| serde_json::from_str(&row?).map_err(Error::from))
        .collect::<Result<Vec<_>, Error>>()?;
    if questions.len() > 64 {
        return Err(Error::Invalid("pending question budget exceeded".into()));
    }
    Ok(questions)
}
pub(crate) fn reconcile(tx: &Transaction<'_>, session: &str, run: &str) -> Result<(), Error> {
    for question in pending(tx, session)? {
        if question["run_id"] == run {
            append(
                tx,
                session,
                "question.resolved",
                json!({"question_id":question["question_id"],"state":"cancelled"}),
            )?;
        }
    }
    Ok(())
}
