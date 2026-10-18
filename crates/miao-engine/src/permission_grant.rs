//! Exact persistent permission scopes. This module stores authority facts only;
//! capability, explicit deny and effective-policy evaluation remain runtime-owned.
use crate::protocol::Error;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 65536;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Scope {
    workspace: String,
    authority_revision: String,
    tool: String,
    resource: String,
    targets: Vec<String>,
    input_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fields {
    workspace: String,
    authority_revision: String,
    tool: String,
    resource: String,
    targets: Vec<String>,
    input_hash: String,
}

impl Scope {
    /// `authority_revision` is opaque and must cover the entire effective
    /// authority, including the selected agent manifest. Targets must come from
    /// the tool's authority descriptor, never a model-provided scope proposal.
    pub fn new(
        workspace: String,
        authority_revision: String,
        tool: String,
        resource: String,
        mut targets: Vec<String>,
        input_hash: String,
    ) -> Result<Self, Error> {
        let bounded = |value: &str, maximum: usize| {
            !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
        };
        if !bounded(&workspace, 8192)
            || !bounded(&authority_revision, 1024)
            || !bounded(&tool, 256)
            || !bounded(&resource, 8192)
            || targets.len() > 64
            || targets.iter().any(|target| !bounded(target, 8192))
            || input_hash.len() != 64
            || !input_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        targets.sort();
        targets.dedup();
        let scope = Self {
            workspace,
            authority_revision,
            tool,
            resource,
            targets,
            input_hash,
        };
        scope.encode()?;
        Ok(scope)
    }

    pub fn decode(input: &str) -> Result<Self, Error> {
        if input.len() > MAX_BYTES {
            return Err(invalid());
        }
        let fields: Fields = serde_json::from_str(input).map_err(|_| invalid())?;
        Self::new(
            fields.workspace,
            fields.authority_revision,
            fields.tool,
            fields.resource,
            fields.targets,
            fields.input_hash,
        )
    }

    pub(crate) fn matches_approval(&self, approval: &crate::approval::Approval) -> bool {
        self.workspace == approval.location
            && self.tool == approval.tool
            && self.resource == approval.resource
            && self.input_hash == approval.input_hash
    }

    fn encode(&self) -> Result<String, Error> {
        let encoded = serde_json::to_string(self)?;
        if encoded.len() > MAX_BYTES {
            return Err(invalid());
        }
        Ok(encoded)
    }

    fn key(&self) -> Result<String, Error> {
        let mut hash = Sha256::new();
        hash.update(b"miao.permission-grant.v1\0");
        hash.update(self.encode()?.as_bytes());
        Ok(format!("{:x}", hash.finalize()))
    }
}

fn invalid() -> Error {
    Error::Invalid("invalid exact permission grant scope".into())
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS engine_permission_grant(scope_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS engine_permission_request_scope(request_id TEXT PRIMARY KEY REFERENCES engine_approval(id) ON DELETE CASCADE,scope TEXT NOT NULL);")?;
    Ok(())
}

pub(crate) fn bind_request(
    transaction: &Transaction<'_>,
    approval: &crate::approval::Approval,
    scope: &Scope,
) -> Result<(), Error> {
    if !scope.matches_approval(approval) {
        return Err(Error::ApprovalMismatch);
    }
    transaction.execute(
        "INSERT INTO engine_permission_request_scope(request_id,scope) VALUES(?1,?2)",
        params![approval.request_id, scope.encode()?],
    )?;
    Ok(())
}

pub(crate) fn request_scope(
    connection: &Connection,
    approval: &crate::approval::Approval,
) -> Result<Scope, Error> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT scope FROM engine_permission_request_scope WHERE request_id=?1",
            [&approval.request_id],
            |row| row.get(0),
        )
        .optional()?;
    let scope =
        Scope::decode(&stored.ok_or_else(|| {
            Error::Invalid("persistent scope unavailable for this approval".into())
        })?)?;
    if !scope.matches_approval(approval) {
        return Err(Error::ApprovalMismatch);
    }
    Ok(scope)
}

/// The caller owns the transaction so approval resolution and grant creation
/// commit together.
pub(crate) fn insert(
    transaction: &Transaction<'_>,
    scope: &Scope,
    created_at_ms: u64,
) -> Result<(), Error> {
    let created_at_ms = i64::try_from(created_at_ms).map_err(|_| invalid())?;
    transaction.execute("INSERT INTO engine_permission_grant(scope_hash,scope,created_at_ms) VALUES(?1,?2,?3) ON CONFLICT(scope_hash) DO NOTHING", params![scope.key()?, scope.encode()?, created_at_ms])?;
    Ok(())
}

pub(crate) fn contains(connection: &Connection, scope: &Scope) -> Result<bool, Error> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT scope FROM engine_permission_grant WHERE scope_hash=?1",
            [scope.key()?],
            |row| row.get(0),
        )
        .optional()?;
    let Some(stored) = stored else {
        return Ok(false);
    };
    if Scope::decode(&stored)? != *scope {
        return Err(invalid());
    }
    Ok(true)
}

pub(crate) fn revoke(transaction: &Transaction<'_>, scope: &Scope) -> Result<bool, Error> {
    Ok(transaction.execute(
        "DELETE FROM engine_permission_grant WHERE scope_hash=?1",
        [scope.key()?],
    )? != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> Scope {
        Scope::new(
            "/workspace".into(),
            "policy-and-agent-revision".into(),
            "edit_file".into(),
            "file".into(),
            vec!["/workspace/b".into(), "/workspace/a".into()],
            "a".repeat(64),
        )
        .unwrap()
    }

    #[test]
    fn transaction_rollback_restart_and_exact_authority_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("grants.db");
        let mut connection = Connection::open(&database).unwrap();
        initialize(&connection).unwrap();
        let original = scope();
        {
            let transaction = connection.transaction().unwrap();
            insert(&transaction, &original, 1).unwrap();
            assert!(contains(&transaction, &original).unwrap());
        }
        assert!(!contains(&connection, &original).unwrap());
        let transaction = connection.transaction().unwrap();
        insert(&transaction, &original, 2).unwrap();
        transaction.commit().unwrap();
        drop(connection);
        let mut connection = Connection::open(&database).unwrap();
        assert!(contains(&connection, &original).unwrap());
        for field in [
            "workspace",
            "authority_revision",
            "tool",
            "resource",
            "input_hash",
            "targets",
        ] {
            let mut value = serde_json::to_value(&original).unwrap();
            value[field] = match field {
                "input_hash" => json!("b".repeat(64)),
                "targets" => json!(["/workspace/a"]),
                _ => json!(format!("changed-{field}")),
            };
            assert!(
                !contains(&connection, &Scope::decode(&value.to_string()).unwrap()).unwrap(),
                "{field}"
            );
        }
        let transaction = connection.transaction().unwrap();
        assert!(revoke(&transaction, &original).unwrap());
        transaction.commit().unwrap();
        assert!(!contains(&connection, &original).unwrap());
    }

    #[tokio::test]
    async fn store_upgrade_reopen_and_revocation_preserve_exact_scopes() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("engine.db");
        {
            let connection = Connection::open(&database).unwrap();
            connection.execute_batch("PRAGMA application_id=1296646469; PRAGMA user_version=12; CREATE TABLE engine_session(id TEXT PRIMARY KEY,next_seq INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'build'); INSERT INTO engine_session VALUES('existing',0,'build');").unwrap();
        }
        let store = crate::store::Store::open(&database).await.unwrap();
        let original = scope();
        store.put_permission_grant(original.clone()).await.unwrap();
        store.put_permission_grant(original.clone()).await.unwrap();
        store.close().await.unwrap();
        let store = crate::store::Store::open(&database).await.unwrap();
        assert!(store.has_permission_grant(original.clone()).await.unwrap());
        assert!(store
            .revoke_permission_grant(original.clone())
            .await
            .unwrap());
        assert!(!store
            .revoke_permission_grant(original.clone())
            .await
            .unwrap());
        assert!(!store.has_permission_grant(original).await.unwrap());
        store.close().await.unwrap();
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM engine_session WHERE id='existing'",
                    [],
                    |row| row.get::<_, u64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .unwrap(),
            crate::store::SCHEMA_VERSION
        );
    }

    #[test]
    fn bounded_decode_canonical_targets_and_corrupt_rows_fail_closed() {
        let original = scope();
        let mut value = serde_json::to_value(&original).unwrap();
        value["targets"] = json!(["/workspace/b", "/workspace/a", "/workspace/b"]);
        assert_eq!(Scope::decode(&value.to_string()).unwrap(), original);
        for invalid_value in [
            json!({"workspace":"/workspace"}),
            {
                let mut value = value.clone();
                value["unexpected"] = json!(true);
                value
            },
            {
                let mut value = value.clone();
                value["tool"] = json!("edit\nfile");
                value
            },
            {
                let mut value = value.clone();
                value["input_hash"] = json!("*".repeat(64));
                value
            },
            {
                let mut value = value.clone();
                value["targets"] = json!(vec!["a"; 65]);
                value
            },
        ] {
            assert!(Scope::decode(&invalid_value.to_string()).is_err());
        }
        assert!(Scope::decode(&" ".repeat(MAX_BYTES + 1)).is_err());
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        let transaction = connection.transaction().unwrap();
        insert(&transaction, &original, 1).unwrap();
        transaction.commit().unwrap();
        connection
            .execute("UPDATE engine_permission_grant SET scope='{}'", [])
            .unwrap();
        assert!(contains(&connection, &original).is_err());
    }
}
