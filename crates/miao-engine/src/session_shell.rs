//! Durable operator shell identities. Admission and execution are separate:
//! replaying a receipt never repeats a dispatched external side effect.
use crate::{
    protocol::Error,
    store::{append, append_at, finish_run_tx, require_lease, write_tx, SessionLease, Store},
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub call_id: String,
    pub command: String,
    pub timeout_ms: u64,
}

impl Invocation {
    pub fn validate(&self) -> Result<(), Error> {
        if self.call_id.is_empty()
            || self.call_id.len() > 128
            || self.call_id.chars().any(char::is_control)
        {
            return Err(Error::Invalid("invalid operator shell identity".into()));
        }
        crate::process::BashInput::parse(
            json!({"command":self.command,"timeout_ms":self.timeout_ms}),
        )
        .map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(())
    }

    /// The execution table is shared with policy/approval machinery; prefixing
    /// the opaque key prevents an operator from aliasing a model's tool id.
    pub(crate) fn execution_id(&self, session: &str) -> String {
        format!(
            "operator-shell:{}",
            crate::permission::digest(format!("{session}\0{}", self.call_id).as_bytes())
        )
    }
}

fn receipt(tx: &Transaction<'_>, session: &str, call: &str) -> Result<Option<Value>, Error> {
    let admitted:Option<(u64,String)>=tx.query_row("SELECT seq,data FROM engine_event WHERE session_id=?1 AND kind='shell.admitted' AND json_extract(data,'$.call_id')=?2 ORDER BY seq LIMIT 1",params![session,call],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    let Some((seq, data)) = admitted else {
        return Ok(None);
    };
    let mut value: Value = serde_json::from_str(&data)?;
    let settled:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind IN ('shell.ended','shell.refused') AND json_extract(data,'$.call_id')=?2 ORDER BY seq DESC LIMIT 1",params![session,call],|row|row.get(0)).optional()?;
    if let Some(settled) = settled {
        let settled: Value = serde_json::from_str(&settled)?;
        value["state"] = json!(if settled["refused"] == true {
            "refused"
        } else if settled["reason"] == "unknown" {
            "unknown"
        } else {
            "ended"
        });
        value["result"] = settled;
        value["admitted_seq"] = json!(seq);
        return Ok(Some(value));
    }
    let claimed:Option<String>=tx.query_row("SELECT data FROM engine_event WHERE session_id=?1 AND kind='shell.claimed' AND json_extract(data,'$.call_id')=?2 ORDER BY seq LIMIT 1",params![session,call],|row|row.get(0)).optional()?;
    let state = if let Some(claimed) = claimed {
        let claimed: Value = serde_json::from_str(&claimed)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_run WHERE id=?1 AND session_id=?2 AND state='running')",params![claimed["run_id"].as_str(),session],|row|row.get(0))?;
        if active {
            "running"
        } else {
            "unknown"
        }
    } else {
        "pending"
    };
    value["state"] = json!(state);
    value["admitted_seq"] = json!(seq);
    Ok(Some(value))
}

impl Store {
    pub async fn admit_shell(&self, session: &str, invocation: Invocation) -> Result<Value, Error> {
        invocation.validate()?;
        let session = session.to_owned();
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM engine_session WHERE id=?1)",[&session],|row|row.get(0))?;
            if !exists {return Err(Error::Invalid("Session does not exist".into()));}
            if let Some(mut existing)=receipt(&tx,&session,&invocation.call_id)? {
                if existing["command"]!=invocation.command || existing["timeout_ms"]!=invocation.timeout_ms {return Err(Error::Conflict);}
                existing["duplicate"]=json!(true);
                return Ok(existing);
            }
            append(&tx,&session,"shell.admitted",json!({"call_id":invocation.call_id,"command":invocation.command,"timeout_ms":invocation.timeout_ms,"origin":"operator"}))?;
            let mut value=receipt(&tx,&session,&invocation.call_id)?.ok_or_else(||Error::Invalid("missing shell admission".into()))?;
            value["duplicate"]=json!(false);
            tx.commit()?;
            Ok(value)
        }).await
    }

    pub(crate) async fn refuse_pending_shell(
        &self,
        session: &str,
        call: &str,
    ) -> Result<(), Error> {
        let (session, call) = (session.to_owned(), call.to_owned());
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            let current=receipt(&tx,&session,&call)?.ok_or_else(||Error::Invalid("operator shell does not exist".into()))?;
            if current["state"]!="pending" {return Ok(());}
            append(&tx,&session,"shell.refused",json!({"call_id":call,"command":current["command"],"origin":"operator","refused":true,"output":"Operator cancelled this shell before execution.","reason":"cancelled_before_start"}))?;
            tx.commit()?;
            Ok(())
        }).await
    }

    pub async fn shell_status(&self, session: &str, call: &str) -> Result<Value, Error> {
        let (session, call) = (session.to_owned(), call.to_owned());
        self.call(move |connection| {
            let tx = connection.transaction()?;
            receipt(&tx, &session, &call)?
                .ok_or_else(|| Error::Invalid("operator shell does not exist".into()))
        })
        .await
    }
}

impl Store {
    pub(crate) async fn claim_shell(
        &self,
        session: &str,
        run: &str,
        invocation: Invocation,
        lease: &SessionLease,
    ) -> Result<bool, Error> {
        let (session, run, lease) = (session.to_owned(), run.to_owned(), lease.clone());
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            require_lease(&tx,&session,&lease)?;
            let current=receipt(&tx,&session,&invocation.call_id)?.ok_or_else(||Error::Invalid("operator shell does not exist".into()))?;
            if current["state"]!="pending" {return Ok(false);}
            let call=invocation.execution_id(&session);
            let input=json!({"command":invocation.command,"timeout_ms":invocation.timeout_ms});
            tx.execute("INSERT INTO engine_tool(id,run_id,name,input,state) VALUES(?1,?2,'bash',?3,'planned')",params![format!("{run}/{call}"),run,serde_json::to_string(&json!({"type":"operator_shell","origin":"operator","id":call,"name":"bash","input":input}))?])?;
            append(&tx,&session,"shell.claimed",json!({"call_id":invocation.call_id,"execution_id":call,"run_id":run,"origin":"operator"}))?;
            tx.commit()?;
            Ok(true)
        }).await
    }

    pub(crate) async fn start_shell(
        &self,
        session: &str,
        run: &str,
        invocation: Invocation,
        lease: &SessionLease,
    ) -> Result<u64, Error> {
        let (session, run, lease) = (session.to_owned(), run.to_owned(), lease.clone());
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            require_lease(&tx,&session,&lease)?;
            let changed=tx.execute("UPDATE engine_tool SET state='dispatched' WHERE id=?1 AND state='planned'",[format!("{run}/{}",invocation.execution_id(&session))])?;
            if changed!=1 {return Err(Error::Conflict);}
            let event=append(&tx,&session,"shell.started",json!({"call_id":invocation.call_id,"command":invocation.command,"run_id":run,"origin":"operator"}))?;
            tx.commit()?;
            Ok(event.seq)
        }).await
    }

    pub(crate) async fn settle_shell(
        &self,
        session: &str,
        run: &str,
        invocation: Invocation,
        result: Value,
        lease: &SessionLease,
    ) -> Result<Value, Error> {
        let (session, run, lease) = (session.to_owned(), run.to_owned(), lease.clone());
        self.call(move |connection| {
            let tx=write_tx(connection)?;
            require_lease(&tx,&session,&lease)?;
            let current=receipt(&tx,&session,&invocation.call_id)?.ok_or_else(||Error::Invalid("operator shell does not exist".into()))?;
            if matches!(current["state"].as_str(),Some("ended"|"refused")) {return Ok(current);}
            let refused=result["refused"]==true;
            let mut data=result;
            data["call_id"]=json!(invocation.call_id);
            data["command"]=json!(invocation.command);
            data["timeout_ms"]=json!(invocation.timeout_ms);
            data["origin"]=json!("operator");
            let event=append(&tx,&session,if refused {"shell.refused"} else {"shell.ended"},data.clone())?;
            if !refused {
                let content=history_content(&data,&invocation.call_id)?;
                tx.execute("INSERT INTO engine_message(session_id,seq,role,content,recorded_at_ms) VALUES(?1,?2,'user',?3,?4)",params![session,event.seq,serde_json::to_string(&content)?,event.recorded_at_ms])?;
            }
            tx.execute("UPDATE engine_tool SET state=?2 WHERE id=?1",params![format!("{run}/{}",invocation.execution_id(&session)),if data["reason"]=="unknown" {"unknown"} else {"completed"}])?;
            let reason=if refused {"denied"} else if data["reason"]=="cancelled" {"interrupted"} else {"completed"};
            finish_run_tx(&tx,&session,&run,reason,Some(&lease))?;
            let value=receipt(&tx,&session,&invocation.call_id)?.ok_or_else(||Error::Invalid("operator shell result missing".into()))?;
            tx.commit()?;
            Ok(value)
        }).await
    }
}

/// Preserve operator provenance when a fork copies a settled history row.
pub(crate) fn copy_history(
    tx: &Transaction<'_>,
    parent: &str,
    target: &str,
    message: &Value,
) -> Result<Option<crate::protocol::Event>, Error> {
    let source: Option<String> = tx
        .query_row(
            "SELECT data FROM engine_event WHERE session_id=?1 AND seq=?2 AND kind='shell.ended'",
            params![parent, message["seq"].as_u64()],
            |row| row.get(0),
        )
        .optional()?;
    let Some(source) = source else {
        return Ok(None);
    };
    let mut ended: Value = serde_json::from_str(&source)?;
    let started:(String,Option<u64>)=tx.query_row("SELECT data,recorded_at_ms FROM engine_event WHERE session_id=?1 AND seq=?2 AND kind='shell.started'",params![parent,ended["started_seq"].as_u64()],|row|Ok((row.get(0)?,row.get(1)?)))?;
    let mut started_data: Value = serde_json::from_str(&started.0)?;
    let call = format!(
        "inherited-{}",
        crate::permission::digest(format!("{parent}/{}/{}", message["seq"], target).as_bytes())
    );
    let provenance = json!({"session_id":parent,"seq":message["seq"]});
    append_at(
        tx,
        target,
        "shell.admitted",
        json!({"call_id":call,"command":ended["command"],"timeout_ms":ended["timeout_ms"],"origin":"operator","inherited":provenance}),
        started.1,
    )?;
    if let Some(data) = started_data.as_object_mut() {
        data.remove("run_id");
    }
    started_data["call_id"] = json!(call);
    started_data["inherited"] = provenance.clone();
    let first = append_at(tx, target, "shell.started", started_data, started.1)?;
    ended["call_id"] = json!(call);
    ended["started_seq"] = json!(first.seq);
    ended["inherited"] = provenance;
    let content = history_content(&ended, &call)?;
    let last = append_at(
        tx,
        target,
        "shell.ended",
        ended,
        message["recorded_at_ms"].as_u64(),
    )?;
    tx.execute("INSERT INTO engine_message(session_id,seq,role,content,recorded_at_ms) VALUES(?1,?2,'user',?3,?4)",params![target,last.seq,serde_json::to_string(&content)?,last.recorded_at_ms])?;
    Ok(Some(last))
}

fn history_content(result: &Value, handle: &str) -> Result<Value, Error> {
    let output = result["output"].as_str().unwrap_or("");
    let mut end = output.len().min(16384);
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    let marker = if end < output.len() {
        format!("\n[output elided; recall handle {handle}]")
    } else {
        String::new()
    };
    Ok(
        json!([{"type":"text","text":format!("<operator-shell command={} exit_code={} reason={} truncated={}>\n{}{}\n</operator-shell>",serde_json::to_string(&result["command"])?,result["exit_code"],serde_json::to_string(&result["reason"])?,result["truncated"],&output[..end],marker)}]),
    )
}
