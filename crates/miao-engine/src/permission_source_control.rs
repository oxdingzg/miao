//! Model-free control of an existing Session store's directory handoff.
use crate::{
    permission_context::Snapshot, permission_source::Target, protocol::Error, store::Store,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub struct Controller {
    store: Store,
    project: String,
    directory: String,
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
    Prepare(Prepare),
    Complete(Box<Complete>),
    Shutdown,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepare {
    authority: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Complete {
    snapshot: Snapshot,
}

impl Controller {
    pub async fn open(
        path: impl AsRef<Path>,
        project: String,
        directory: impl AsRef<Path>,
    ) -> Result<Self, Error> {
        crate::permission_migration::require_rules(&project, &[])?;
        if directory.as_ref().as_os_str().is_empty()
            || !tokio::fs::metadata(path.as_ref()).await?.is_file()
        {
            return Err(Error::Invalid(
                "permission source requires an existing database and directory".into(),
            ));
        }
        let directory = tokio::fs::canonicalize(directory).await?;
        if !tokio::fs::metadata(&directory).await?.is_dir() {
            return Err(Error::Invalid(
                "permission source requires a directory".into(),
            ));
        }
        let directory = directory
            .to_str()
            .ok_or_else(|| Error::Invalid("permission source requires a UTF-8 directory".into()))?
            .to_owned();
        Ok(Self {
            store: Store::open(path).await?,
            project,
            directory,
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
                json!({"id":id,"error":{"code":"invalid_request","message":"expected a permission source control request"}}),
                false,
            );
        };
        let shutdown = matches!(request.command, Command::Shutdown);
        let result: Result<Value, Error> = async {
            Ok(match request.command {
                Command::Snapshot => {
                    let record = self
                        .store
                        .directory_permission_source(self.directory.clone())
                        .await?;
                    if record
                        .as_ref()
                        .is_some_and(|record| record.target.project != self.project)
                    {
                        return Err(Error::Invalid(
                            "permission source project binding mismatch".into(),
                        ));
                    }
                    serde_json::to_value(record)?
                }
                Command::Prepare(input) => serde_json::to_value(
                    self.store
                        .prepare_directory_permission_source(
                            self.directory.clone(),
                            Target {
                                authority: input.authority,
                                project: self.project.clone(),
                                directory: self.directory.clone(),
                                workspace_id: None,
                            },
                        )
                        .await?,
                )?,
                Command::Complete(input) => {
                    if input.snapshot.project.project != self.project {
                        return Err(Error::Invalid(
                            "permission source project binding mismatch".into(),
                        ));
                    }
                    serde_json::to_value(
                        self.store
                            .complete_directory_permission_source(
                                self.directory.clone(),
                                input.snapshot,
                            )
                            .await?,
                    )?
                }
                Command::Shutdown => json!({"accepted":true}),
            })
        }
        .await;
        match result {
            Ok(result) => (json!({"id":request.id,"result":result}), shutdown),
            Err(error) => (
                json!({"id":request.id,"error":{"code":error.code(),"message":error.to_string()}}),
                shutdown,
            ),
        }
    }

    pub async fn close(self) -> Result<(), Error> {
        self.store.close().await
    }
}
