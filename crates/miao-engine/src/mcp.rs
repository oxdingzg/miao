use crate::{
    permission::digest,
    protocol::{Error, ToolDefinition},
    tools::ToolError,
};
use rmcp::{
    model::{CallToolRequestParams, CallToolResponse, PaginatedRequestParams},
    service::RunningService,
    RoleClient, ServiceExt,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    pin::Pin,
    process::Stdio,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
struct Tool {
    definition: ToolDefinition,
    native: String,
    server: Arc<Server>,
    validator: jsonschema::Validator,
}
struct Server {
    name: String,
    client: Mutex<RunningService<RoleClient, ()>>,
}

/// Connections are explicitly trusted host services, not model-selected URLs
/// or commands. Tool calls are separate External authority and remain gated.
pub struct Registry {
    tools: BTreeMap<String, Tool>,
    servers: Vec<Arc<Server>>,
    children: Mutex<Vec<Child>>,
}
impl Registry {
    pub async fn connect(configs: Vec<Config>, workspace: &Path) -> Result<Self, Error> {
        if configs.len() > 8 {
            return Err(Error::Invalid("MCP server limit".into()));
        }
        let mut registry = Self {
            tools: BTreeMap::new(),
            servers: vec![],
            children: Mutex::new(vec![]),
        };
        for config in configs {
            validate_name(&config.name)?;
            if config.argv.is_empty()
                || config.argv.len() > 128
                || config.argv[0].is_empty()
                || config
                    .argv
                    .iter()
                    .any(|arg| arg.contains('\0') || arg.len() > 8192)
                || config.env.len() > 32
                || config.env.iter().any(|(key, value)| {
                    key.is_empty()
                        || key.len() > 256
                        || key.contains(['\0', '='])
                        || value.contains('\0')
                        || value.len() > 8192
                })
            {
                return Err(Error::Invalid("invalid MCP server configuration".into()));
            }
            if registry
                .servers
                .iter()
                .any(|server| server.name == config.name)
            {
                return Err(Error::Invalid("duplicate MCP server name".into()));
            }
            let mut command = Command::new(&config.argv[0]);
            command
                .args(&config.argv[1..])
                .current_dir(workspace)
                .env_clear();
            for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            command.envs(config.env);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut child = command
                .spawn()
                .map_err(|_| Error::Invalid("MCP process could not start".into()))?;
            let read = child
                .stdout
                .take()
                .ok_or_else(|| Error::Invalid("MCP stdout missing".into()))?;
            let write = child
                .stdin
                .take()
                .ok_or_else(|| Error::Invalid("MCP stdin missing".into()))?;
            let client = tokio::time::timeout(
                Duration::from_secs(15),
                ().serve((FrameReader::new(read), write)),
            )
            .await
            .map_err(|_| Error::Invalid("MCP initialization timed out".into()))?
            .map_err(|_| Error::Invalid("MCP initialization failed".into()))?;
            registry.attach(config.name, client).await?;
            registry.children.lock().await.push(child);
        }
        Ok(registry)
    }

    pub async fn connect_io<R, W>(name: String, read: R, write: W) -> Result<Self, Error>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        validate_name(&name)?;
        let client = tokio::time::timeout(
            Duration::from_secs(15),
            ().serve((FrameReader::new(read), write)),
        )
        .await
        .map_err(|_| Error::Invalid("MCP initialization timed out".into()))?
        .map_err(|_| Error::Invalid("MCP initialization failed".into()))?;
        let mut registry = Self {
            tools: BTreeMap::new(),
            servers: vec![],
            children: Mutex::new(vec![]),
        };
        registry.attach(name, client).await?;
        Ok(registry)
    }

    async fn attach(
        &mut self,
        name: String,
        client: RunningService<RoleClient, ()>,
    ) -> Result<(), Error> {
        let mut cursor = None;
        let mut catalog = Vec::new();
        let mut pages = 0;
        loop {
            if pages >= 4 {
                return Err(Error::Invalid("MCP catalog pagination limit".into()));
            }
            pages += 1;
            let params = cursor
                .map(|cursor| {
                    serde_json::from_value::<PaginatedRequestParams>(
                        serde_json::json!({"cursor":cursor}),
                    )
                })
                .transpose()?;
            let page = tokio::time::timeout(Duration::from_secs(15), client.list_tools(params))
                .await
                .map_err(|_| Error::Invalid("MCP catalog timed out".into()))?
                .map_err(|_| Error::Invalid("MCP catalog failed".into()))?;
            catalog.extend(page.tools);
            if catalog.len() > 128 {
                return Err(Error::Invalid("MCP tool limit".into()));
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        let server = Arc::new(Server {
            name: name.clone(),
            client: Mutex::new(client),
        });
        for tool in catalog {
            let native = tool.name.to_string();
            if native.is_empty() || native.len() > 256 {
                return Err(Error::Invalid("invalid MCP tool name".into()));
            }
            let alias = alias(&name, &native);
            let input_schema = serde_json::to_value(&tool.input_schema)?;
            if serde_json::to_vec(&input_schema)?.len() > 32768 || input_schema["type"] != "object"
            {
                return Err(Error::Invalid("unsupported MCP tool schema".into()));
            }
            let validator = jsonschema::validator_for(&input_schema)
                .map_err(|_| Error::Invalid("unsupported MCP validation schema".into()))?;
            let description = tool
                .description
                .as_ref()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "External MCP tool".into());
            if description.len() > 4096 {
                return Err(Error::Invalid("MCP description limit".into()));
            }
            let definition = ToolDefinition {
                name: alias.clone(),
                description: format!(
                    "[MCP server {name}; requires external-tool authorization] {description}"
                ),
                input_schema,
            };
            if self
                .tools
                .insert(
                    alias,
                    Tool {
                        definition,
                        native,
                        server: server.clone(),
                        validator,
                    },
                )
                .is_some()
            {
                return Err(Error::Invalid("duplicate MCP tool alias".into()));
            }
        }
        self.servers.push(server);
        Ok(())
    }
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|tool| tool.definition.clone())
            .collect()
    }
    pub fn resource(&self, name: &str) -> Option<String> {
        self.tools
            .get(name)
            .map(|tool| format!("@mcp/{}/{}", tool.server.name, name))
    }
    pub fn validate(&self, name: &str, input: &Value) -> Result<(), ToolError> {
        let tool = self.tools.get(name).ok_or(ToolError::Unsupported)?;
        if !input.is_object() || !tool.validator.is_valid(input) {
            return Err(ToolError::InvalidInput);
        }
        Ok(())
    }
    pub async fn call(
        &self,
        name: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        self.validate(name, &input)?;
        let tool = self.tools.get(name).ok_or(ToolError::Unsupported)?;
        let args = input.as_object().ok_or(ToolError::InvalidInput)?.clone();
        let client = tokio::select! {biased; _=cancel.cancelled()=>return Err(ToolError::Interrupted),client=tool.server.client.lock()=>client};
        let request = CallToolRequestParams::new(tool.native.clone()).with_arguments(args);
        let response = tokio::select! {
            biased;
            _=cancel.cancelled()=>return Err(ToolError::Interrupted),
            response=tokio::time::timeout(Duration::from_secs(60),client.call_tool_once(request))=>response.map_err(|_|ToolError::External("MCP request timed out; outcome may be unknown".into()))?.map_err(|_|ToolError::External("MCP request failed; no automatic replay".into()))?,
        };
        let CallToolResponse::Complete(result) = response else {
            return Err(ToolError::External(
                "MCP input/task continuation is not supported; no automatic replay".into(),
            ));
        };
        let result = serde_json::to_value(result).map_err(|_| ToolError::InvalidInput)?;
        if serde_json::to_vec(&result)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > 65536
        {
            return Err(ToolError::External(
                "MCP result exceeds output budget".into(),
            ));
        }
        Ok(result)
    }
    pub async fn shutdown(&self) {
        for server in &self.servers {
            let mut client = server.client.lock().await;
            let _ = client.close_with_timeout(Duration::from_secs(2)).await;
        }
        for child in self.children.lock().await.iter_mut() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}
fn validate_name(name: &str) -> Result<(), Error> {
    if name.is_empty()
        || name.len() > 32
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(Error::Invalid(
            "MCP server name must be bounded ASCII".into(),
        ));
    }
    Ok(())
}
fn alias(server: &str, tool: &str) -> String {
    let suffix = digest(format!("{server}\0{tool}").as_bytes());
    let slug: String = tool
        .chars()
        .take(14)
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!(
        "mcp_{}_{}_{}",
        server.chars().take(12).collect::<String>(),
        slug,
        &suffix[..32]
    )
}

// Bound each newline-delimited wire frame before rmcp allocates its full line.
struct FrameReader<R> {
    inner: R,
    length: usize,
}
impl<R> FrameReader<R> {
    fn new(inner: R) -> Self {
        Self { inner, length: 0 }
    }
}
impl<R: AsyncRead + Unpin> AsyncRead for FrameReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        let start = buf.filled().len();
        match Pin::new(&mut this.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                for byte in &buf.filled()[start..] {
                    if *byte == b'\n' {
                        this.length = 0;
                        continue;
                    }
                    this.length += 1;
                    if this.length > 262144 {
                        return Poll::Ready(Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "MCP frame exceeds 256 KiB",
                        )));
                    }
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
