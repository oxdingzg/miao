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
const MAX_FEEDBACK_BYTES: usize = 4096;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denial: Option<Outcome>,
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
         ON engine_product_permission_request(session_id,state);
         CREATE INDEX IF NOT EXISTS engine_product_permission_owner_pending
         ON engine_product_permission_request(owner,workspace,state);",
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
            let auto = outcome.effect == Decision::Ask && context.authority.auto && classify(&context, &input);
            let state = if auto { State::Allowed } else { match outcome.effect { Decision::Allow => State::Allowed, Decision::Deny => State::Denied, Decision::Ask => State::Pending } };
            if state == State::Pending {
                let pending: usize = transaction.query_row("SELECT COUNT(*) FROM engine_product_permission_request WHERE session_id=?1 AND state='pending'", [&context.source.session_id], |row| row.get(0))?;
                if pending >= MAX_PENDING { return Err(Error::Invalid("product permission pending budget exceeded".into())); }
            }
            let now = now_ms();
            let record = Record {
                id: input.request_id.clone(), source: context.source.clone(), workspace: context.workspace.clone(),
                expires_at_ms: input.timeout_ms.map(|timeout| now.saturating_add(timeout)), request: input,
                input_hash: hash, authority_revision: outcome.authority_revision.clone(), created_at_ms: now, state,
                reply: None, reason: if auto { Some("auto_allowed".into()) } else { (state == State::Denied).then(|| "policy_denied".into()) }, feedback: None,
                denial: (outcome.effect == Decision::Deny).then_some(outcome),
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

    pub(crate) async fn cancel_product_permission(
        &self,
        context: Context,
        id: String,
    ) -> Result<Record, Error> {
        self.call(move |connection| {
            with_source(connection, &context, |transaction| {
                let (owner, mut record) = load(transaction, &id)?
                    .ok_or_else(|| Error::Invalid("product permission request not found".into()))?;
                require_binding(&context, &owner, &record)?;
                if record.state != State::Pending || expire(transaction, &mut record)? {
                    return Ok(record);
                }
                record.state = State::Cancelled;
                record.reason = Some("caller_cancelled".into());
                resolve(transaction, &record)?;
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
        if response
            .message
            .as_ref()
            .is_some_and(|message| message.len() > MAX_FEEDBACK_BYTES || message.contains('\0'))
        {
            return Err(Error::Invalid(
                "permission reply feedback must be at most 4096 UTF-8 bytes and contain no NUL"
                    .into(),
            ));
        }
        // The host only interprets a message on reject, and an empty message
        // means ordinary decline. Ignored presentation must not affect retries.
        let feedback = response
            .message
            .filter(|message| response.reply == Reply::Reject && !message.is_empty());
        self.call(move |connection| {
            with_sources(connection, &context, |transaction, sources| {
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
                    if record.reply == Some(response.reply) && record.feedback == feedback {
                        return Ok(record);
                    }
                    return Err(Error::Invalid(
                        "product permission is already resolved".into(),
                    ));
                }
                if expire(transaction, &mut record)? {
                    return Ok(record);
                }
                let outcome = if response.reply == Reply::Reject {
                    None
                } else {
                    Some(evaluate(transaction, &context, &record.request.facts)?)
                };
                let denied = response.reply == Reply::Reject
                    || outcome
                        .as_ref()
                        .is_some_and(|outcome| outcome.effect == Decision::Deny);
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
                record.feedback = feedback;
                record.denial = outcome.filter(|outcome| outcome.effect == Decision::Deny);
                record.reason = denied.then(|| {
                    match response.reply {
                        Reply::Reject if record.feedback.is_some() => "user_corrected",
                        Reply::Reject => "user_rejected",
                        _ => "policy_denied",
                    }
                    .into()
                });
                resolve(transaction, &record)?;
                resolve_siblings(transaction, &context, sources, &record)?;
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
    with_sources(connection, context, |transaction, _| execute(transaction))
}

pub(crate) fn with_sources<T>(
    connection: &mut Connection,
    context: &Context,
    execute: impl FnOnce(&Transaction<'_>, &[(Source, &Authority)]) -> Result<T, Error>,
) -> Result<T, Error> {
    // Wait for storage before taking process-local source locks. Attached
    // shared-authority transactions must use the same order to avoid a cycle.
    let transaction = crate::store::write_tx(connection)?;
    // Keep product then call locked through commit; cancellation can withdraw
    // while storage is busy, but cannot overtake an entered authorization.
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
        .with_permission_sources(&context.source, |sources| {
            require_active(&transaction, context)?;
            let result = execute(&transaction, sources)?;
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
    if !source_active(connection, context)? {
        return Err(Error::Invalid("inactive product permission source".into()));
    }
    Ok(())
}

fn source_active(connection: &Connection, context: &Context) -> Result<bool, Error> {
    let active = crate::product_permission::source_active(
        connection,
        &context.source.session_id,
        &context.authority.run_id,
        &context.source.call_id,
        &context.workspace,
    )?;
    Ok(active && !context.authority.cancel.is_cancelled())
}

fn resolve_siblings(
    transaction: &Transaction<'_>,
    context: &Context,
    sources: &[(Source, &Authority)],
    resolved: &Record,
) -> Result<(), Error> {
    let reject = resolved.reply == Some(Reply::Reject);
    let remember = resolved.state == State::Allowed
        && resolved.reply == Some(Reply::Always)
        && resolved
            .request
            .save
            .as_ref()
            .is_some_and(|save| !save.is_empty());
    if !reject && !remember {
        return Ok(());
    }
    // Snapshot before settling peers: a later assertion must not inherit a
    // rejection of the requests that were already waiting alongside this one.
    let records = {
        let mut statement = transaction.prepare("SELECT data FROM engine_product_permission_request WHERE owner=?1 AND workspace=?2 AND state='pending' AND id!=?3 AND (?4 IS NULL OR session_id=?4) ORDER BY id")?;
        let rows = statement.query_map(
            params![
                context.owner,
                context.workspace,
                resolved.id,
                reject.then_some(&context.source.session_id)
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.map(|row| serde_json::from_str::<Record>(&row?).map_err(Error::from))
            .collect::<Result<Vec<_>, Error>>()?
    };
    for mut record in records {
        if expire(transaction, &mut record)? {
            continue;
        }
        let authority = sources
            .iter()
            .find_map(|(source, authority)| (source == &record.source).then_some(*authority));
        let Some(authority) = authority else {
            record.state = State::Cancelled;
            record.reason = Some("source_finished".into());
            resolve(transaction, &record)?;
            continue;
        };
        let sibling = Context {
            source: record.source.clone(),
            authority: authority.clone(),
            ..context.clone()
        };
        require_binding(&sibling, &context.owner, &record)?;
        if !source_active(transaction, &sibling)? {
            record.state = State::Cancelled;
            record.reason = Some("source_finished".into());
            resolve(transaction, &record)?;
            continue;
        }
        if !reject
            && evaluate(transaction, &sibling, &record.request.facts)?.effect != Decision::Allow
        {
            continue;
        }
        record.state = if reject {
            State::Denied
        } else {
            State::Allowed
        };
        record.reply = Some(if reject { Reply::Reject } else { Reply::Always });
        record.reason = reject.then(|| "user_rejected".into());
        record.feedback = None;
        resolve(transaction, &record)?;
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
        &json!({"semantics":"product-permission-authority-v2","workspace":context.workspace,"policy":context.authority.policy_revision,"boundary":context.boundary,"host":context.authority.host,"auto":context.authority.auto,"rules":outcome.authority_revision}),
    )?);
    Ok(outcome)
}

pub(crate) fn classify(context: &Context, input: &Input) -> bool {
    use crate::agent_classifier::{bash, host_edit, Verdict};
    match input.facts.actions.first().map(String::as_str) {
        Some("edit") => host_edit(&input.facts.resources, &context.authority.host) == Verdict::Safe,
        Some("bash")
            if input
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("stdin"))
                .is_none() =>
        {
            input
                .facts
                .resources
                .iter()
                .all(|command| bash(command) == Verdict::Safe)
        }
        _ => false,
    }
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

pub(crate) fn state_name(state: State) -> &'static str {
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

pub(crate) fn require_input(input: &Input) -> Result<(), Error> {
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
