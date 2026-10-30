//! Durable host assertions in the shared authority. Runtime activation is explicit.
use crate::{
    approval::now_ms,
    permission::{digest, Decision},
    permission_context::Context,
    permission_patterns::{Origin, Pattern},
    permission_rules::{Outcome, Rule},
    permission_source_transaction::Source,
    product_permission_request::{Input, Record, Reply, Response, State},
    protocol::Error,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE permission_request(
           id TEXT PRIMARY KEY,project TEXT NOT NULL,location TEXT NOT NULL,
           owner TEXT NOT NULL,session TEXT NOT NULL,binding TEXT NOT NULL,
           state TEXT NOT NULL,data TEXT NOT NULL
         );
         CREATE INDEX permission_request_pending ON permission_request(project,location,owner,session,state);
         CREATE TABLE permission_request_event(
           seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(seq BETWEEN 1 AND 9007199254740991),
           request_id TEXT NOT NULL REFERENCES permission_request(id),state TEXT NOT NULL,data TEXT NOT NULL
         );
         CREATE TRIGGER permission_request_event_no_update BEFORE UPDATE ON permission_request_event
         BEGIN SELECT RAISE(ABORT,'permission request events are immutable'); END;
         CREATE TRIGGER permission_request_event_no_delete BEFORE DELETE ON permission_request_event
         BEGIN SELECT RAISE(ABORT,'permission request events are immutable'); END;"
    )?;
    Ok(())
}

pub(crate) fn initialize_origins(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("ALTER TABLE permission_request ADD COLUMN origin TEXT;")?;
    let records = {
        let mut statement = connection
            .prepare("SELECT id,data FROM permission_request WHERE state='pending' ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, data) in records {
        let mut record: Record = serde_json::from_str(&data)?;
        if record.id != id || record.state != State::Pending {
            return Err(Error::Invalid(
                "corrupt legacy shared permission request".into(),
            ));
        }
        // A v4 row has no durable source run/epoch. Never guess the source or
        // replay its provider; retain history and cancel only that pending ask.
        record.state = State::Cancelled;
        record.reason = Some("source_metadata_unavailable".into());
        resolve_request(connection, &record)?;
    }
    connection.execute_batch("CREATE TRIGGER permission_request_origin_required BEFORE INSERT ON permission_request
        WHEN NEW.origin IS NULL OR json_valid(NEW.origin)!=1
        BEGIN SELECT RAISE(ABORT,'durable permission source metadata is required'); END;
        CREATE TRIGGER permission_request_binding_immutable BEFORE UPDATE OF project,location,owner,session,binding,origin ON permission_request
        WHEN NEW.project IS NOT OLD.project OR NEW.location IS NOT OLD.location OR NEW.owner IS NOT OLD.owner OR NEW.session IS NOT OLD.session OR NEW.binding IS NOT OLD.binding OR NEW.origin IS NOT OLD.origin
        BEGIN SELECT RAISE(ABORT,'permission request source binding is immutable'); END;")?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct Recovery {
    pub settled: usize,
    pub after: Option<String>,
    pub has_more: bool,
}

impl Context {
    /// Cancel only sources durably known to be inactive. A live foreign source
    /// stays pending; this does not reconstruct its bridge or replay a provider.
    pub async fn recover_source_requests(
        &self,
        source: &crate::store::Store,
        after: Option<String>,
        limit: usize,
    ) -> Result<Recovery, Error> {
        if self.workspace_id.is_some()
            || limit == 0
            || limit > 256
            || after
                .as_ref()
                .is_some_and(|id| id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err(Error::Invalid(
                "invalid shared request recovery scope or page".into(),
            ));
        }
        let context = self.clone();
        let path = source.path().to_path_buf();
        self.project.authority.call(move |connection| {
            crate::permission_source_transaction::with_locked_source_database(connection,&path,|transaction,_| {
                let database=path.to_str().ok_or_else(||Error::Invalid("invalid permission source database path".into()))?;
                let mut rows={
                    let mut statement=transaction.prepare("SELECT id,owner,session,binding,data,origin FROM permission_request WHERE project=?1 AND location=?2 AND state='pending' AND json_extract(origin,'$.database')=?3 AND (?4 IS NULL OR id>?4) ORDER BY id LIMIT ?5")?;
                    let rows=statement.query_map(params![context.project.project,context.location,database,after,limit+1],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?)))?;
                    rows.collect::<Result<Vec<_>,_>>()?
                };
                let has_more=rows.len()>limit;
                rows.truncate(limit);
                let after=rows.last().map(|row|row.0.clone()).or(after);
                let mut settled=0;
                let mut owners=std::collections::HashMap::new();
                for (id,owner,session,binding,data,origin) in rows {
                    let origin:crate::permission_source_transaction::Origin=serde_json::from_str(&origin)?;
                    let mut record:Record=serde_json::from_str(&data)?;
                    let expected=context.request_binding_for_origin(&transaction,&origin,&owner,&record.source)?;
                    let input_hash=digest(&serde_json::to_vec(&json!({"binding":binding,"input":record.request}))?);
                    if origin.database!=path || origin.owner_pid==0 || origin.lease_epoch==0 || binding!=expected || record.id!=id || record.request.request_id!=id || record.source.session_id!=session || record.workspace!=context.directory || record.input_hash!=input_hash || record.state!=State::Pending {
                        return Err(Error::Invalid("corrupt shared request recovery binding".into()));
                    }
                    if expire_request(&transaction,&mut record)? {settled+=1;continue;}
                    let active:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM permission_source.engine_tool t JOIN permission_source.engine_run r ON r.id=t.run_id JOIN permission_source.engine_location l ON l.session_id=r.session_id JOIN permission_source.engine_lease e ON e.session_id=r.session_id WHERE t.id=?1 AND t.state='dispatched' AND r.id=?2 AND r.session_id=?3 AND r.state='running' AND l.root=?4 AND r.lease_epoch=?5 AND e.epoch=?5 AND e.owner_pid=?6)",params![format!("{}/{}",origin.run_id,record.source.call_id),origin.run_id,session,context.directory,origin.lease_epoch,origin.owner_pid],|row|row.get(0))?;
                    let live=*owners.entry(origin.owner_pid).or_insert_with(||crate::store::pid_alive(origin.owner_pid));
                    if active && live {continue;}
                    record.state=State::Cancelled;
                    record.reason=Some(if live {"source_finished"} else {"source_owner_exited"}.into());
                    resolve_request(&transaction,&record)?;
                    settled+=1;
                }
                transaction.commit()?;
                Ok(Recovery{settled,after,has_more})
            })
        }).await
    }

    /// The trusted host binds the context; every admission rechecks the actual
    /// Runtime source and its execution lease inside the Root write transaction.
    pub async fn admit_request(&self, source: &Source, input: Input) -> Result<Record, Error> {
        crate::product_permission_request::require_input(&input)?;
        let context = self.clone();
        let source = source.clone();
        self.project.authority.with_permission_source(&source.clone(), move |transaction| {
            context.require_request_source(&source)?;
            let binding = context.request_binding(transaction, &source)?;
            let input_hash = digest(&serde_json::to_vec(&json!({"binding":binding,"input":input}))?);
            if let Some(mut record) = context.load_request(transaction, &source, &input.request_id)? {
                if record.input_hash != input_hash { return Err(Error::Invalid("conflicting shared permission request id".into())); }
                context.refresh_request(transaction, &source, &mut record)?;
                return Ok(record);
            }
            let outcome = context.evaluate_request(transaction, &source, &input)?;
            let auto = outcome.effect == Decision::Ask && source.context.authority.auto && crate::product_permission_request::classify(&source.context, &input);
            let state = if auto { State::Allowed } else { match outcome.effect { Decision::Allow => State::Allowed, Decision::Deny => State::Denied, Decision::Ask => State::Pending } };
            if state == State::Pending {
                let count: usize = transaction.query_row("SELECT count(*) FROM permission_request WHERE owner=?1 AND session=?2 AND state='pending'",params![source.context.owner,source.context.source.session_id],|row|row.get(0))?;
                if count >= 64 { return Err(Error::Invalid("shared permission pending budget exceeded".into())); }
            }
            let created_at_ms=now_ms();
            let record=Record {
                id: input.request_id.clone(),source:source.context.source.clone(),workspace:context.directory.clone(),
                input_hash,authority_revision:outcome.authority_revision.clone(),created_at_ms,
                expires_at_ms:input.timeout_ms.map(|timeout|created_at_ms.saturating_add(timeout)),request:input,state,reply:None,
                reason: if auto {Some("auto_allowed".into())} else {(state==State::Denied).then(||"policy_denied".into())},feedback:None,
                denial:(outcome.effect==Decision::Deny).then_some(outcome),
            };
            transaction.execute("INSERT INTO permission_request(id,project,location,owner,session,binding,state,data,origin) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![record.id,context.project.project,context.location,source.context.owner,record.source.session_id,binding,crate::product_permission_request::state_name(record.state),serde_json::to_string(&record)?,serde_json::to_string(&source.origin())?])?;
            request_event(transaction,&record)?;
            Ok(record)
        }).await
    }

    /// Owners poll their own live source. A rule change may settle this source
    /// only after its captured agent policy and cancellation fence are checked.
    pub async fn request_status(&self, source: &Source, id: String) -> Result<Record, Error> {
        let context = self.clone();
        let source = source.clone();
        self.project
            .authority
            .with_permission_source(&source.clone(), move |transaction| {
                context.require_request_source(&source)?;
                let mut record = context
                    .load_request(transaction, &source, &id)?
                    .ok_or_else(|| Error::Invalid("shared permission request not found".into()))?;
                context.refresh_request(transaction, &source, &mut record)?;
                Ok(record)
            })
            .await
    }

    /// Always saves only explicit patterns. Rule changes, invalidations and the
    /// reply receipt commit together in Root; the Session database stays read-only.
    pub async fn reply_request(
        &self,
        source: &Source,
        response: Response,
    ) -> Result<Record, Error> {
        if response
            .message
            .as_ref()
            .is_some_and(|message| message.len() > 4096 || message.contains('\0'))
        {
            return Err(Error::Invalid(
                "invalid shared permission reply feedback".into(),
            ));
        }
        let feedback = response
            .message
            .filter(|message| response.reply == Reply::Reject && !message.is_empty());
        let context = self.clone();
        let source = source.clone();
        self.project
            .authority
            .call(move |connection| {
                source.with_root_sources(connection, |transaction, sources| {
                    context.require_request_source(&source)?;
                    let mut record = context
                        .load_request(transaction, &source, &response.request_id)?
                        .ok_or_else(|| {
                            Error::Invalid("shared permission request not found".into())
                        })?;
                    if record.input_hash != response.input_hash
                        || record.authority_revision != response.authority_revision
                    {
                        return Err(Error::Invalid(
                            "shared permission response binding mismatch".into(),
                        ));
                    }
                    if record.state != State::Pending {
                        if record.reply == Some(response.reply) && record.feedback == feedback {
                            return Ok(record);
                        }
                        return Err(Error::Invalid(
                            "shared permission request is already resolved".into(),
                        ));
                    }
                    if expire_request(transaction, &mut record)? {
                        return Ok(record);
                    }
                    let outcome =
                        context.evaluate_request(transaction, &source, &record.request)?;
                    let denied =
                        response.reply == Reply::Reject || outcome.effect == Decision::Deny;
                    if !denied && response.reply == Reply::Always {
                        for resource in record.request.save.as_deref().unwrap_or_default() {
                            context.put_request_rule(
                                transaction,
                                Rule {
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
                    record.denial = (outcome.effect == Decision::Deny).then_some(outcome);
                    record.reason = denied.then(|| {
                        match response.reply {
                            Reply::Reject if record.feedback.is_some() => "user_corrected",
                            Reply::Reject => "user_rejected",
                            _ => "policy_denied",
                        }
                        .into()
                    });
                    resolve_request(transaction, &record)?;
                    context.resolve_request_siblings(transaction, &source, sources, &record)?;
                    Ok(record)
                })
            })
            .await
    }

    /// Per-request cancellation never applies the user's reject fan-out policy.
    pub async fn cancel_request(&self, source: &Source, id: String) -> Result<Record, Error> {
        let context = self.clone();
        let source = source.clone();
        self.project
            .authority
            .with_permission_source(&source.clone(), move |transaction| {
                context.require_request_source(&source)?;
                let mut record = context
                    .load_request(transaction, &source, &id)?
                    .ok_or_else(|| Error::Invalid("shared permission request not found".into()))?;
                if record.state != State::Pending || expire_request(transaction, &mut record)? {
                    return Ok(record);
                }
                record.state = State::Cancelled;
                record.reason = Some("caller_cancelled".into());
                resolve_request(transaction, &record)?;
                Ok(record)
            })
            .await
    }

    /// A trusted owner may withdraw its own captured source after the tool or
    /// Runtime has ended. This operation only cancels; it never reads a grant,
    /// saves a rule or revives an inactive source.
    pub async fn retire_source_requests(&self, source: &Source) -> Result<usize, Error> {
        let context = self.clone();
        let source = source.clone();
        self.project.authority.call(move |connection| {
            context.require_request_source(&source)?;
            let transaction=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let binding=context.request_binding(&transaction,&source)?;
            let ids={
                let mut statement=transaction.prepare("SELECT id FROM permission_request WHERE binding=?1 AND state='pending' ORDER BY id")?;
                let rows=statement.query_map([binding],|row|row.get::<_,String>(0))?;
                rows.collect::<Result<Vec<_>,_>>()?
            };
            for id in &ids {
                let mut record=context.load_request(&transaction,&source,id)?.ok_or_else(||Error::Invalid("shared permission request disappeared".into()))?;
                if expire_request(&transaction,&mut record)? {continue;}
                record.state=State::Cancelled;
                record.reason=Some("source_finished".into());
                resolve_request(&transaction,&record)?;
            }
            transaction.commit()?;
            Ok(ids.len())
        }).await
    }

    fn resolve_request_siblings(
        &self,
        transaction: &Transaction<'_>,
        source: &Source,
        sources: &[(
            crate::product_permission::Source,
            &crate::product_permission::Authority,
        )],
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
        let records = {
            let mut statement=transaction.prepare("SELECT data FROM permission_request WHERE project=?1 AND location=?2 AND owner=?3 AND state='pending' AND id!=?4 AND (?5 IS NULL OR session=?5) ORDER BY id")?;
            let rows = statement.query_map(
                params![
                    self.project.project,
                    self.location,
                    source.context.owner,
                    resolved.id,
                    reject.then_some(&resolved.source.session_id)
                ],
                |row| row.get::<_, String>(0),
            )?;
            rows.map(|row| serde_json::from_str::<Record>(&row?).map_err(Error::from))
                .collect::<Result<Vec<_>, Error>>()?
        };
        for mut record in records {
            if expire_request(transaction, &mut record)? {
                continue;
            }
            let authority = sources
                .iter()
                .find_map(|(peer, authority)| (peer == &record.source).then_some(*authority));
            let authority = match authority {
                Some(authority)
                    if !authority.cancel.is_cancelled()
                        && crate::product_permission::source_epoch_matches(
                            transaction,
                            &authority.run_id,
                            authority.lease_epoch,
                            true,
                        )?
                        && crate::product_permission::source_active_in(
                            transaction,
                            &record.source.session_id,
                            &authority.run_id,
                            &record.source.call_id,
                            &self.directory,
                            true,
                        )? =>
                {
                    authority
                }
                _ => {
                    record.state = State::Cancelled;
                    record.reason = Some("source_finished".into());
                    resolve_request(transaction, &record)?;
                    continue;
                }
            };
            let peer = Source {
                path: source.path.clone(),
                context: crate::product_permission_request::Context {
                    source: record.source.clone(),
                    authority: authority.clone(),
                    ..source.context.clone()
                },
            };
            self.load_request(transaction, &peer, &record.id)?
                .ok_or_else(|| Error::Invalid("shared permission sibling disappeared".into()))?;
            if !reject
                && self
                    .evaluate_request(transaction, &peer, &record.request)?
                    .effect
                    != Decision::Allow
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
            resolve_request(transaction, &record)?;
        }
        Ok(())
    }

    fn require_request_source(&self, source: &Source) -> Result<(), Error> {
        if self.directory != source.context.workspace || self.workspace_id.is_some() {
            return Err(Error::Invalid(
                "shared permission source scope mismatch".into(),
            ));
        }
        Ok(())
    }

    fn request_binding(&self, connection: &Connection, source: &Source) -> Result<String, Error> {
        self.request_binding_for_origin(
            connection,
            &source.origin(),
            &source.context.owner,
            &source.context.source,
        )
    }

    fn request_binding_for_origin(
        &self,
        connection: &Connection,
        origin: &crate::permission_source_transaction::Origin,
        owner: &str,
        source: &crate::product_permission::Source,
    ) -> Result<String, Error> {
        let authority = crate::permission_changefeed::cursor(connection)?.authority;
        Ok(digest(&serde_json::to_vec(
            &json!({"semantics":"shared-permission-source-v2","authority":authority,"project":self.project.project,"location":self.location,"origin":origin,"owner":owner,"source":source}),
        )?))
    }

    fn load_request(
        &self,
        connection: &Connection,
        source: &Source,
        id: &str,
    ) -> Result<Option<Record>, Error> {
        let row: Option<(String, String, String, Option<String>)> = connection
            .query_row(
                "SELECT binding,state,data,origin FROM permission_request WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        row.map(|(binding, state, data, origin)| {
            let origin: crate::permission_source_transaction::Origin =
                serde_json::from_str(origin.as_deref().ok_or_else(|| {
                    Error::Invalid("shared permission source metadata is missing".into())
                })?)?;
            if origin != source.origin() {
                return Err(Error::Invalid(
                    "shared permission source metadata mismatch".into(),
                ));
            }
            let record: Record = serde_json::from_str(&data)?;
            let input_hash = digest(&serde_json::to_vec(
                &json!({"binding":binding,"input":record.request}),
            )?);
            if binding != self.request_binding(connection, source)?
                || record.id != id
                || record.request.request_id != id
                || record.source != source.context.source
                || record.workspace != self.directory
                || record.input_hash != input_hash
                || state != crate::product_permission_request::state_name(record.state)
            {
                return Err(Error::Invalid(
                    "shared permission request binding mismatch".into(),
                ));
            }
            Ok(record)
        })
        .transpose()
    }

    fn evaluate_request(
        &self,
        connection: &Connection,
        source: &Source,
        input: &Input,
    ) -> Result<Outcome, Error> {
        let snapshot = self.view(connection)?;
        let saved = snapshot
            .project
            .rules
            .into_iter()
            .map(|record| record.rule)
            .chain(snapshot.patterns.into_iter().map(|pattern| pattern.rule))
            .collect();
        let mut outcome = crate::permission_rules::evaluate(&crate::permission_rules::Request {
            actions: input.facts.actions.clone(),
            resources: input.facts.resources.clone(),
            explicit: input.facts.explicit,
            configured: source.context.authority.configured.clone(),
            saved: Some(saved),
        })?;
        outcome.authority_revision = digest(&serde_json::to_vec(
            &json!({"binding":self.request_binding(connection,source)?,"policy":source.context.authority.policy_revision,"boundary":source.context.boundary,"host":source.context.authority.host,"auto":source.context.authority.auto,"rules":outcome.authority_revision}),
        )?);
        Ok(outcome)
    }

    fn refresh_request(
        &self,
        transaction: &Transaction<'_>,
        source: &Source,
        record: &mut Record,
    ) -> Result<(), Error> {
        if record.state != State::Pending || expire_request(transaction, record)? {
            return Ok(());
        }
        let outcome = self.evaluate_request(transaction, source, &record.request)?;
        if outcome.effect == Decision::Ask {
            return Ok(());
        }
        record.state = if outcome.effect == Decision::Allow {
            State::Allowed
        } else {
            State::Denied
        };
        record.reason = Some(
            if outcome.effect == Decision::Allow {
                "saved_rules_allowed"
            } else {
                "policy_denied"
            }
            .into(),
        );
        record.denial = (outcome.effect == Decision::Deny).then_some(outcome);
        resolve_request(transaction, record)
    }

    fn put_request_rule(&self, transaction: &Transaction<'_>, rule: Rule) -> Result<(), Error> {
        crate::permission_patterns::require_rule(&rule)?;
        let id = crate::permission_context::pattern_id(&self.directory, &rule)?;
        if self
            .view(transaction)?
            .patterns
            .iter()
            .any(|pattern| pattern.id == id)
        {
            return Ok(());
        }
        self.ensure(transaction)?;
        self.insert(
            transaction,
            &Pattern {
                id,
                workspace: self.directory.clone(),
                rule,
                source: Origin::Native,
                created_at_ms: now_ms(),
            },
        )?;
        self.bump(transaction)
    }
}

fn expire_request(transaction: &Transaction<'_>, record: &mut Record) -> Result<bool, Error> {
    if record.state != State::Pending
        || !record
            .expires_at_ms
            .is_some_and(|expires| now_ms() >= expires)
    {
        return Ok(false);
    }
    record.state = State::Expired;
    record.reason = Some("expired".into());
    resolve_request(transaction, record)?;
    Ok(true)
}

fn resolve_request(transaction: &Connection, record: &Record) -> Result<(), Error> {
    transaction.execute(
        "UPDATE permission_request SET state=?1,data=?2 WHERE id=?3",
        params![
            crate::product_permission_request::state_name(record.state),
            serde_json::to_string(record)?,
            record.id
        ],
    )?;
    request_event(transaction, record)
}

fn request_event(transaction: &Connection, record: &Record) -> Result<(), Error> {
    transaction.execute(
        "INSERT INTO permission_request_event(request_id,state,data) VALUES(?1,?2,?3)",
        params![
            record.id,
            crate::product_permission_request::state_name(record.state),
            serde_json::to_string(record)?
        ],
    )?;
    Ok(())
}
