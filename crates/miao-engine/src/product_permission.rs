//! Runtime-owned rule evaluation for one active product-tool reverse call.
//! This query neither executes a host action nor creates an approval or grant.
use crate::{permission_rules::Rule, product::CallContext, protocol::Error, store::Store};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub session_id: String,
    pub bridge_id: u64,
    pub call_id: String,
    pub message_seq: u64,
}

/// Host-provided action/resource facts only. Configured and saved rules come
/// from the captured turn and attached store, never from controller arguments.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub actions: Vec<String>,
    pub resources: Vec<String>,
    #[serde(default)]
    pub explicit: bool,
}

#[derive(Clone)]
pub(crate) struct Authority {
    pub run_id: String,
    pub context: CallContext,
    pub policy_revision: String,
    pub configured: Option<Vec<Rule>>,
    pub auto: bool,
    pub host: crate::product::HostContext,
    pub cancel: CancellationToken,
}

impl Store {
    pub(crate) async fn product_permission_rules(
        &self,
        session: String,
        run: String,
        call: String,
        workspace: String,
    ) -> Result<Vec<Rule>, Error> {
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let active = source_active(&transaction, &session, &run, &call, &workspace)?;
            if !active {
                return Err(Error::Invalid("inactive product permission source".into()));
            }
            let rules = crate::permission_saved::rules(&transaction, &workspace)?;
            transaction.commit()?;
            Ok(rules)
        })
        .await
    }
}

/// A real dispatched source must still own the claim that started its run.
/// Historical/unfenced runs have no authority to create live tool grants.
pub(crate) fn source_active(
    connection: &Connection,
    session: &str,
    run: &str,
    call: &str,
    workspace: &str,
) -> Result<bool, Error> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM engine_tool t JOIN engine_run r ON r.id=t.run_id JOIN engine_location l ON l.session_id=r.session_id JOIN engine_lease e ON e.session_id=r.session_id WHERE t.id=?1 AND t.state='dispatched' AND r.id=?2 AND r.session_id=?3 AND r.state='running' AND l.root=?4 AND r.lease_epoch=e.epoch AND e.owner_pid=?5)",
        params![format!("{run}/{call}"), run, session, workspace, std::process::id()],
        |row| row.get(0),
    )?)
}
