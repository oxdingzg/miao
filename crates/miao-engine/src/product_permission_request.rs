//! Durable permission assertions for live host product calls. These requests
//! belong to dispatched source tools, not the planned-tool approval cache.
use crate::{
    approval::now_ms,
    permission::{digest, Decision},
    permission_rules::{Outcome, Rule},
    product_permission::{Authority, Request, Source},
    protocol::Error,
    store::{append, Store},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};

const MAX_PENDING: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub request_id: String,
    pub facts: Request,
    #[serde(default)]
    pub save: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    Allowed,
    Denied,
    Cancelled,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reply {
    Once,
    Always,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub request_id: String,
    pub input_hash: String,
    pub authority_revision: String,
    pub reply: Reply,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub source: Source,
    pub workspace: String,
    pub request: Input,
    pub input_hash: String,
    pub authority_revision: String,
    pub created_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub state: State,
    pub reply: Option<Reply>,
    pub reason: Option<String>,
}

#[derive(Clone)]
pub(crate) struct Context {
    pub owner: String,
    pub source: Source,
    pub authority: Authority,
    pub workspace: String,
    pub boundary: Value,
    pub bridge: crate::product::Bridge,
    pub product: Arc<RwLock<crate::product::State>>,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS engine_product_permission_request(
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL REFERENCES engine_session(id) ON DELETE CASCADE,
           run_id TEXT NOT NULL REFERENCES engine_run(id) ON DELETE CASCADE,
           call_id TEXT NOT NULL REFERENCES engine_tool(id) ON DELETE CASCADE,
           workspace TEXT NOT NULL,
           owner TEXT NOT NULL,
           state TEXT NOT NULL,
           data TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS engine_product_permission_pending
         ON engine_product_permission_request(session_id,state);",
    )?;
    Ok(())
}

impl Store {
    pub(crate) async fn admit_product_permission(
        &self,
        context: Context,
        input: Input,
    ) -> Result<Record, Error> {
        require_input(&input)?;
        self.call(move |connection| with_source(connection, &context, |transaction| {
            let hash = input_hash(&context.owner, &context.source, &input)?;
            if let Some((owner, mut record)) = load(transaction, &input.request_id)? {
                require_binding(&context, &owner, &record)?;
                if record.input_hash != hash { return Err(Error::Invalid("conflicting product permission request id".into())); }
                expire(transaction, &mut record)?;
                return Ok(record);
            }
            let outcome = evaluate(transaction, &context, &input.facts)?;
            let state = match outcome.effect { Decision::Allow => State::Allowed, Decision::Deny => State::Denied, Decision::Ask => State::Pending };
            if state == State::Pending {
                let pending: usize = transaction.query_row("SELECT COUNT(*) FROM engine_product_permission_request WHERE session_id=?1 AND state='pending'", [&context.source.session_id], |row| row.get(0))?;
                if pending >= MAX_PENDING { return Err(Error::Invalid("product permission pending budget exceeded".into())); }
            }
            let now = now_ms();
            let record = Record {
                id: input.request_id.clone(), source: context.source.clone(), workspace: context.workspace.clone(),
                expires_at_ms: input.timeout_ms.map(|timeout| now.saturating_add(timeout)), request: input,
                input_hash: hash, authority_revision: outcome.authority_revision, created_at_ms: now, state,
                reply: None, reason: (state == State::Denied).then(|| "policy_denied".into()),
            };
            transaction.execute("INSERT INTO engine_product_permission_request(id,session_id,run_id,call_id,workspace,owner,state,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![record.id, context.source.session_id, context.authority.run_id, format!("{}/{}",context.authority.run_id,context.source.call_id), context.workspace,context.owner,state_name(state),serde_json::to_string(&record)?])?;
            if state == State::Pending { append(transaction, &context.source.session_id, "product.permission.requested", serde_json::to_value(&record)?)?; }
            Ok(record)
        })).await
    }

    pub(crate) async fn product_permission_status(
        &self,
        context: Context,
        id: String,
    ) -> Result<Record, Error> {
        self.call(move |connection| {
            with_source(connection, &context, |transaction| {
                let (owner, mut record) = load(transaction, &id)?
                    .ok_or_else(|| Error::Invalid("product permission request not found".into()))?;
                require_binding(&context, &owner, &record)?;
                expire(transaction, &mut record)?;
                Ok(record)
            })
        })
        .await
    }

    pub(crate) async fn reply_product_permission(
        &self,
        context: Context,
        response: Response,
    ) -> Result<Record, Error> {
        self.call(move |connection| {
            with_source(connection, &context, |transaction| {
                let (owner, mut record) = load(transaction, &response.request_id)?
                    .ok_or_else(|| Error::Invalid("product permission request not found".into()))?;
                require_binding(&context, &owner, &record)?;
                if record.input_hash != response.input_hash
                    || record.authority_revision != response.authority_revision
                {
                    return Err(Error::Invalid(
                        "product permission response binding mismatch".into(),
                    ));
                }
                if record.state != State::Pending {
                    if record.reply == Some(response.reply) {
                        return Ok(record);
                    }
                    return Err(Error::Invalid(
                        "product permission is already resolved".into(),
                    ));
                }
                if expire(transaction, &mut record)? {
                    return Ok(record);
                }
                let denied = response.reply == Reply::Reject
                    || evaluate(transaction, &context, &record.request.facts)?.effect
                        == Decision::Deny;
                if !denied && response.reply == Reply::Always {
                    for resource in record.request.save.as_deref().unwrap_or_default() {
                        crate::permission_patterns::put_in(
                            transaction,
                            &context.workspace,
                            &Rule {
                                action: record.request.facts.actions[0].clone(),
                                resource: resource.clone(),
                                effect: Decision::Allow,
                            },
                        )?;
                    }
                }
                record.state = if denied {
                    State::Denied
                } else {
                    State::Allowed
                };
                record.reply = Some(response.reply);
                record.reason = denied.then(|| {
                    if response.reply == Reply::Reject {
                        "user_rejected"
                    } else {
                        "policy_denied"
                    }
                    .into()
                });
                resolve(transaction, &record)?;
                Ok(record)
            })
        })
        .await
    }

    pub(crate) async fn pending_product_permissions(
        &self,
        owner: String,
        workspace: String,
        session: String,
    ) -> Result<Vec<Record>, Error> {
        self.call(move |connection| {
            let transaction = crate::store::write_tx(connection)?;
            let mut records = {
                let mut statement = transaction.prepare("SELECT data FROM engine_product_permission_request WHERE owner=?1 AND workspace=?2 AND session_id=?3 AND state='pending' ORDER BY id LIMIT 65")?;
                let rows = statement.query_map(params![owner,workspace,session], |row| row.get::<_,String>(0))?;
                rows.map(|row| serde_json::from_str::<Record>(&row?).map_err(Error::from)).collect::<Result<Vec<_>,Error>>()?
            };
            if records.len() > MAX_PENDING { return Err(Error::Invalid("product permission pending budget exceeded".into())); }
            for record in &mut records { expire(&transaction, record)?; }
            transaction.commit()?;
            Ok(records.into_iter().filter(|record| record.state == State::Pending).collect())
        }).await
    }
}

pub(crate) fn cancel_pending(
    transaction: &Transaction<'_>,
    session: &str,
    run: &str,
    call: Option<&str>,
) -> Result<(), Error> {
    let records = {
        let mut statement = transaction.prepare("SELECT data FROM engine_product_permission_request WHERE session_id=?1 AND run_id=?2 AND state='pending' AND (?3 IS NULL OR call_id=?3)")?;
        let rows =
            statement.query_map(params![session, run, call], |row| row.get::<_, String>(0))?;
        rows.map(|row| serde_json::from_str::<Record>(&row?).map_err(Error::from))
            .collect::<Result<Vec<_>, Error>>()?
    };
    for mut record in records {
        record.state = State::Cancelled;
        record.reason = Some("source_finished".into());
        resolve(transaction, &record)?;
    }
    Ok(())
}

fn with_source<T>(
    connection: &mut Connection,
    context: &Context,
    execute: impl FnOnce(&Transaction<'_>) -> Result<T, Error>,
) -> Result<T, Error> {
    // Lock order matches bridge replacement/reply delivery: product then call.
    // Both remain held through the SQL commit so an acknowledged cancellation
    // or source replacement cannot precede a later authorization mutation.
    let product = context.product.read().unwrap();
    if !product
        .bridge
        .as_ref()
        .is_some_and(|bridge| bridge.same_connection(&context.bridge))
    {
        return Err(Error::Invalid("inactive product permission source".into()));
    }
    context
        .bridge
        .with_permission_authority(&context.source, |_| {
            let transaction = crate::store::write_tx(connection)?;
            require_active(&transaction, context)?;
            let result = execute(&transaction)?;
            require_active(&transaction, context)?;
            transaction.commit()?;
            Ok(result)
        })
}

fn load(connection: &Connection, id: &str) -> Result<Option<(String, Record)>, Error> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT owner,state,data FROM engine_product_permission_request WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    row.map(|(owner, state, data)| {
        let record: Record = serde_json::from_str(&data)?;
        if record.id != id || state != state_name(record.state) {
            return Err(Error::Invalid("corrupt product permission request".into()));
        }
        Ok((owner, record))
    })
    .transpose()
}

fn require_binding(context: &Context, owner: &str, record: &Record) -> Result<(), Error> {
    if owner != context.owner
        || record.source != context.source
        || record.workspace != context.workspace
        || record.id != record.request.request_id
        || record.input_hash != input_hash(owner, &record.source, &record.request)?
    {
        return Err(Error::Invalid("product permission source mismatch".into()));
    }
    Ok(())
}

fn require_active(connection: &Connection, context: &Context) -> Result<(), Error> {
    let active: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM engine_tool t JOIN engine_run r ON r.id=t.run_id JOIN engine_location l ON l.session_id=r.session_id WHERE t.id=?1 AND t.state='dispatched' AND r.id=?2 AND r.session_id=?3 AND r.state='running' AND l.root=?4)",params![format!("{}/{}",context.authority.run_id,context.source.call_id),context.authority.run_id,context.source.session_id,context.workspace],|row|row.get(0))?;
    if !active || context.authority.cancel.is_cancelled() {
        return Err(Error::Invalid("inactive product permission source".into()));
    }
    Ok(())
}

fn evaluate(connection: &Connection, context: &Context, facts: &Request) -> Result<Outcome, Error> {
    let mut outcome = crate::permission_rules::evaluate(&crate::permission_rules::Request {
        actions: facts.actions.clone(),
        resources: facts.resources.clone(),
        explicit: facts.explicit,
        configured: context.authority.configured.clone(),
        saved: Some(crate::permission_saved::rules(
            connection,
            &context.workspace,
        )?),
    })?;
    outcome.authority_revision = digest(&serde_json::to_vec(
        &json!({"semantics":"product-permission-authority-v1","workspace":context.workspace,"policy":context.authority.policy_revision,"boundary":context.boundary,"rules":outcome.authority_revision}),
    )?);
    Ok(outcome)
}

fn expire(transaction: &Transaction<'_>, record: &mut Record) -> Result<bool, Error> {
    if record.state != State::Pending
        || !record
            .expires_at_ms
            .is_some_and(|expires| now_ms() >= expires)
    {
        return Ok(false);
    }
    record.state = State::Expired;
    record.reason = Some("expired".into());
    resolve(transaction, record)?;
    Ok(true)
}

fn resolve(transaction: &Transaction<'_>, record: &Record) -> Result<(), Error> {
    transaction.execute(
        "UPDATE engine_product_permission_request SET state=?1,data=?2 WHERE id=?3",
        params![
            state_name(record.state),
            serde_json::to_string(record)?,
            record.id
        ],
    )?;
    append(
        transaction,
        &record.source.session_id,
        "product.permission.resolved",
        serde_json::to_value(record)?,
    )?;
    Ok(())
}

fn state_name(state: State) -> &'static str {
    match state {
        State::Pending => "pending",
        State::Allowed => "allowed",
        State::Denied => "denied",
        State::Cancelled => "cancelled",
        State::Expired => "expired",
    }
}

fn input_hash(owner: &str, source: &Source, input: &Input) -> Result<String, Error> {
    Ok(digest(&serde_json::to_vec(
        &json!({"semantics":"product-permission-input-v1","owner":owner,"source":source,"input":input}),
    )?))
}

fn require_input(input: &Input) -> Result<(), Error> {
    if input.request_id.is_empty()
        || input.request_id.len() > 256
        || input.request_id.chars().any(char::is_control)
        || input.facts.actions.is_empty()
        || input.facts.resources.is_empty()
        || input
            .timeout_ms
            .is_some_and(|timeout| !(1..=600_000).contains(&timeout))
        || input.save.as_ref().is_some_and(|save| {
            save.len() > 64
                || save
                    .iter()
                    .any(|resource| resource.len() > 4096 || resource.contains('\0'))
        })
        || serde_json::to_vec(input)?.len() > 16_384
    {
        return Err(Error::Invalid(
            "invalid product permission assertion".into(),
        ));
    }
    Ok(())
}
