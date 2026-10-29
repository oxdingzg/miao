//! Project-bound local control. No provider, Session, or tool authorization loop.
use crate::{
    permission_migration::LegacyRule,
    permission_project::{Authority, Project},
    protocol::Error,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub struct Controller {
    project: Project,
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    #[serde(flatten)]
    command: Command,
}
#[derive(Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
enum Command {
    Snapshot,
    Migrate(Migrate),
    Put(crate::permission_patterns::Put),
    Remove(Remove),
    Shutdown,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Migrate {
    rules: Vec<LegacyRule>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Remove {
    id: String,
}

impl Controller {
    pub async fn open(path: impl AsRef<Path>, project: String) -> Result<Self, Error> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() || path == Path::new(":memory:") {
            return Err(Error::Invalid(
                "project permission control requires a database file".into(),
            ));
        }
        crate::permission_migration::require_rules(&project, &[])?;
        Ok(Self {
            project: Authority::open(path).await?.project(project)?,
        })
    }

    pub async fn dispatch(&self, value: Value) -> (Value, bool) {
        let id = value
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
            .cloned()
            .unwrap_or(Value::Null);
        let request = if id.is_null()
            || value.as_object().is_none_or(|value| {
                value
                    .keys()
                    .any(|key| !["id", "method", "params"].contains(&key.as_str()))
            }) {
            None
        } else {
            serde_json::from_value::<Request>(value).ok()
        };
        let Some(request) = request else {
            return (
                json!({"id":id,"error":{"code":"invalid_request","message":"expected a project permission control request"}}),
                false,
            );
        };
        let shutdown = matches!(request.command, Command::Shutdown);
        let result = match request.command {
            Command::Snapshot => self
                .project
                .snapshot()
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Migrate(input) => self
                .project
                .migrate(input.rules)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Put(input) => self
                .project
                .put(input.rule)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(Error::from)),
            Command::Remove(input) => self
                .project
                .remove(input.id)
                .await
                .map(|removed| json!({"removed":removed})),
            Command::Shutdown => Ok(json!({"accepted":true})),
        };
        let response = match result {
            Ok(value) => json!({"id":request.id,"result":value}),
            Err(error) => {
                json!({"id":request.id,"error":{"code":error.code(),"message":error.to_string()}})
            }
        };
        (response, shutdown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_project_and_ephemeral_paths_do_not_initialize_control() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("permissions.db");
        assert!(Controller::open(&path, "".into()).await.is_err());
        assert!(!path.exists());
        assert!(Controller::open("", "project".into()).await.is_err());
        assert!(Controller::open(":memory:", "project".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn control_is_project_bound_and_opens_no_session_store() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("permissions.db");
        let first = Controller::open(&path, "first".into()).await.unwrap();
        let other = Controller::open(&path, "other".into()).await.unwrap();
        let (saved,stop)=first.dispatch(json!({"id":1,"method":"put","params":{"rule":{"action":"read","resource":"public/**","effect":"allow"}}})).await;
        assert!(!stop);
        assert_eq!(saved["result"]["project"], "first");
        assert_eq!(saved["result"]["revision"], 1);
        let (empty, _) = other.dispatch(json!({"id":2,"method":"snapshot"})).await;
        assert_eq!(empty["result"]["revision"], 0);
        assert_eq!(empty["result"]["rules"], json!([]));
        assert_eq!(saved["result"]["authority"], empty["result"]["authority"]);
        let connection = rusqlite::Connection::open(&path).unwrap();
        let sessions: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='engine_session')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!sessions);
    }

    #[tokio::test]
    async fn malformed_or_foreign_scope_frames_preserve_ids_and_state() {
        let directory = tempfile::tempdir().unwrap();
        let controller =
            Controller::open(directory.path().join("permissions.db"), "project".into())
                .await
                .unwrap();
        for request in [
            json!({"id":"bad","method":"put","params":{"project":"foreign","rule":{"action":"read","resource":"*","effect":"allow"}}}),
            json!({"id":"bad","method":"migrate","params":{"workspace":"/foreign","rules":[]}}),
            json!({"id":"bad","method":"snapshot","project":"foreign"}),
            json!({"id":"bad","method":"admit","params":{}}),
            json!({"id":"bad","method":"put","params":{"rule":{"action":"read","resource":"*","effect":"deny"}}}),
        ] {
            let (response, stop) = controller.dispatch(request).await;
            assert!(!stop);
            assert_eq!(response["id"], "bad");
            assert_eq!(response["error"]["code"], "invalid_request");
        }
        let (snapshot, _) = controller
            .dispatch(json!({"id":5,"method":"snapshot"}))
            .await;
        assert_eq!(snapshot["result"]["revision"], 0);
        let (response, stop) = controller
            .dispatch(json!({"id":6,"method":"shutdown"}))
            .await;
        assert!(stop);
        assert_eq!(response, json!({"id":6,"result":{"accepted":true}}));
    }
}
