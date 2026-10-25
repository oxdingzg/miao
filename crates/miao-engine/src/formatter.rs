//! Host-configured formatters run through the same confined process runner as tools.
use crate::{process, tools::ToolError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub argv: Vec<String>,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "timeout_ms")]
    pub timeout_ms: u64,
}
fn timeout_ms() -> u64 {
    30_000
}

pub struct Registry {
    configs: Vec<Config>,
    workspace: PathBuf,
}
impl Registry {
    pub fn new(configs: Vec<Config>, workspace: &Path) -> Result<Self, ToolError> {
        if configs.len() > 32 {
            return Err(ToolError::InvalidInput);
        }
        for config in &configs {
            if config.name.is_empty()
                || config.name.len() > 128
                || config.argv.is_empty()
                || config.argv.len() > 32
                || config
                    .argv
                    .iter()
                    .any(|arg| arg.is_empty() || arg.len() > 4096 || arg.contains('\0'))
                || config.extensions.len() > 128
                || config
                    .extensions
                    .iter()
                    .any(|ext| ext.len() > 64 || ext.contains(['/', '\\', '\0']))
                || config.env.len() > 32
                || config.env.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > 256
                        || key.contains(['=', '\0'])
                        || value.len() > 8192
                        || value.contains('\0')
                })
                || !(100..=120_000).contains(&config.timeout_ms)
            {
                return Err(ToolError::InvalidInput);
            }
        }
        Ok(Self {
            configs,
            workspace: workspace.to_owned(),
        })
    }

    pub fn descriptor(&self) -> Value {
        json!({"sha256": crate::permission::digest(&serde_json::to_vec(&self.configs).unwrap_or_default())})
    }

    pub async fn file(
        &self,
        file: &Path,
        runner: &Path,
        sandbox: bool,
        cancel: &CancellationToken,
    ) -> Vec<Value> {
        let extension = file.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        let mut results = Vec::new();
        for config in &self.configs {
            if !config
                .extensions
                .iter()
                .any(|ext| ext.trim_start_matches('.').eq_ignore_ascii_case(extension))
            {
                continue;
            }
            if cancel.is_cancelled() {
                results.push(json!({"name":config.name,"status":"cancelled"}));
                break;
            }
            let argv = config
                .argv
                .iter()
                .map(|arg| arg.replace("$FILE", &file.to_string_lossy()))
                .collect();
            let envs = config
                .env
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<Vec<_>>();
            let spawned = process::spawn(
                runner,
                &self.workspace,
                &self.workspace,
                argv,
                config.timeout_ms,
                false,
                false,
                false,
                sandbox,
                &envs,
            )
            .await;
            let (mut group, _, _temp) = match spawned {
                Ok(spawned) => spawned,
                Err(_) => {
                    results.push(json!({"name":config.name,"status":"spawn_error"}));
                    continue;
                }
            };
            let mut readers = tokio::task::JoinSet::new();
            if let Some(mut output) = group.child.stdout.take() {
                readers.spawn(async move {
                    let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await;
                });
            }
            if let Some(mut output) = group.child.stderr.take() {
                readers.spawn(async move {
                    let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await;
                });
            }
            let status = tokio::select! {
                _ = cancel.cancelled() => "cancelled",
                _ = tokio::time::sleep(Duration::from_millis(config.timeout_ms)) => "timeout",
                result = group.child.wait() => if result.is_ok_and(|status| status.success()) { "formatted" } else { "failed" },
            };
            group.terminate();
            let _ = group.child.wait().await;
            readers.abort_all();
            while readers.join_next().await.is_some() {}
            results.push(json!({"name":config.name,"status":status}));
        }
        results
    }
}
