use crate::{protocol::Error, tools::ToolError};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

/// A language server the engine may query for diagnostics, definitions and
/// references. Servers are explicitly configured host services, started lazily
/// on first use and confined to the workspace.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub argv: Vec<String>,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub initialization: Option<Value>,
}

/// A parsed `lsp_*` tool input.
pub struct Query {
    pub path: String,
    pub line: u32,
    pub character: u32,
    pub query: String,
}
impl Query {
    pub fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Position {
            path: String,
            line: Option<u32>,
            character: Option<u32>,
            query: Option<String>,
        }
        let parsed: Position =
            serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if parsed.path.is_empty() || parsed.path.len() > 4096 {
            return Err(ToolError::InvalidInput);
        }
        let position = !matches!(
            name,
            "lsp_diagnostics" | "lsp_document_symbols" | "lsp_workspace_symbols"
        );
        if position && (parsed.line.is_none() || parsed.character.is_none())
            || !position && (parsed.line.is_some() || parsed.character.is_some())
            || parsed.line.is_some_and(|value| value > 10_000_000)
            || parsed.character.is_some_and(|value| value > 10_000_000)
            || name != "lsp_workspace_symbols" && parsed.query.is_some()
            || parsed
                .query
                .as_ref()
                .is_some_and(|query| query.len() > 4096)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(Self {
            path: parsed.path,
            line: parsed.line.unwrap_or_default(),
            character: parsed.character.unwrap_or_default(),
            query: parsed.query.unwrap_or_default(),
        })
    }
}

struct Client {
    read: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    write: Box<dyn AsyncWrite + Unpin + Send>,
    next: u64,
    initialized: bool,
    opened: BTreeMap<String, Document>,
}

struct Document {
    fingerprint: [u8; 32],
    version: u32,
    diagnostics: Option<Vec<Value>>,
    diagnostics_version: Option<u64>,
}

impl Client {
    fn new(
        read: impl AsyncRead + Unpin + Send + 'static,
        write: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        Self {
            read: BufReader::new(Box::new(read)),
            write: Box::new(write),
            next: 1,
            initialized: false,
            opened: BTreeMap::new(),
        }
    }

    async fn send(&mut self, message: &Value) -> Result<(), Error> {
        let body = serde_json::to_vec(message)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.write.write_all(header.as_bytes()).await?;
        self.write.write_all(&body).await?;
        self.write.flush().await?;
        Ok(())
    }

    async fn read_frame(&mut self) -> Result<Option<Value>, Error> {
        let mut length = None;
        loop {
            let mut line = String::new();
            if self.read.read_line(&mut line).await? == 0 {
                return Ok(None);
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                length = rest.trim().parse::<usize>().ok();
            }
        }
        let length =
            length.ok_or_else(|| Error::Invalid("LSP frame missing Content-Length".into()))?;
        if length > 8 * 1024 * 1024 {
            return Err(Error::Invalid("LSP frame exceeds 8 MiB".into()));
        }
        let mut body = vec![0u8; length];
        self.read.read_exact(&mut body).await?;
        Ok(Some(serde_json::from_slice(&body)?))
    }

    /// Answer a server-initiated request so the server does not stall waiting on
    /// a client that will never reply.
    async fn answer_server_request(&mut self, frame: &Value) -> Result<(), Error> {
        self.send(&json!({"jsonrpc":"2.0","id":frame["id"],"result":null}))
            .await
    }

    async fn initialize(
        &mut self,
        root: &Path,
        initialization: Option<&Value>,
    ) -> Result<(), Error> {
        if self.initialized {
            return Ok(());
        }
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"processId":null,"rootUri":uri(root)?,"initializationOptions":initialization,"capabilities":{"textDocument":{"publishDiagnostics":{"versionSupport":true}}}}})).await?;
        loop {
            let frame = self
                .read_frame()
                .await?
                .ok_or_else(|| Error::Invalid("LSP server closed during initialize".into()))?;
            if frame.get("id").is_some() && frame.get("method").is_some() {
                self.answer_server_request(&frame).await?;
                continue;
            }
            if frame.get("id") == Some(&json!(id)) {
                if frame.get("error").is_some() {
                    return Err(Error::Invalid("LSP initialize failed".into()));
                }
                break;
            }
        }
        self.send(&json!({"jsonrpc":"2.0","method":"initialized","params":{}}))
            .await?;
        self.initialized = true;
        Ok(())
    }

    async fn open(&mut self, uri: &str, language: &str, text: &str) -> Result<(), Error> {
        let fingerprint: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        if let Some(document) = self.opened.get(uri) {
            if document.fingerprint == fingerprint {
                return Ok(());
            }
            let version = document
                .version
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("LSP document version exhausted".into()))?;
            self.send(&json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}})).await?;
            self.opened.insert(
                uri.to_owned(),
                Document {
                    fingerprint,
                    version,
                    diagnostics: None,
                    diagnostics_version: None,
                },
            );
            return Ok(());
        }
        // Bound retained document state; closing a document lets the server
        // discard its corresponding text and diagnostics as well.
        if self.opened.len() >= 128 {
            let oldest = self.opened.keys().next().cloned().unwrap();
            self.send(&json!({"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":oldest}}})).await?;
            self.opened.remove(&oldest);
        }
        self.send(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":language,"version":1,"text":text}}})).await?;
        self.opened.insert(
            uri.to_owned(),
            Document {
                fingerprint,
                version: 1,
                diagnostics: None,
                diagnostics_version: None,
            },
        );
        Ok(())
    }

    fn retain_diagnostics(&mut self, frame: &Value) {
        if frame["method"] != "textDocument/publishDiagnostics" {
            return;
        }
        let Some(document) = frame["params"]["uri"]
            .as_str()
            .and_then(|uri| self.opened.get_mut(uri))
        else {
            return;
        };
        if let Some(version) = frame["params"]["version"].as_u64() {
            if version != u64::from(document.version) {
                return;
            }
        }
        document.diagnostics = frame["params"]["diagnostics"]
            .as_array()
            .map(|items| items.iter().take(256).cloned().collect());
        document.diagnostics_version = frame["params"]["version"].as_u64();
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, Error> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(Error::Invalid(format!("LSP {method} timed out")));
            }
            let frame = match tokio::time::timeout(remaining, self.read_frame()).await {
                Ok(Ok(Some(frame))) => frame,
                Ok(Ok(None)) => return Err(Error::Invalid("LSP server closed".into())),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(Error::Invalid(format!("LSP {method} timed out"))),
            };
            if frame.get("id").is_some() && frame.get("method").is_some() {
                self.answer_server_request(&frame).await?;
                continue;
            }
            self.retain_diagnostics(&frame);
            if frame.get("id") == Some(&json!(id)) {
                if frame.get("error").is_some() {
                    return Err(Error::Invalid(format!("LSP {method} failed")));
                }
                let result = frame.get("result").cloned().unwrap_or(Value::Null);
                if serde_json::to_vec(&result)?.len() > 64 * 1024 {
                    return Err(Error::Invalid("LSP result exceeds 64 KiB".into()));
                }
                return Ok(result);
            }
        }
    }

    /// Open the document and collect diagnostics published for it within the
    /// wait window. Servers publish diagnostics as notifications, so the engine
    /// waits a bounded time rather than issuing a request.
    async fn diagnostics(
        &mut self,
        uri: &str,
        language: &str,
        text: &str,
        wait: Duration,
    ) -> Result<Vec<Value>, Error> {
        self.open(uri, language, text).await?;
        if let Some(diagnostics) = self
            .opened
            .get(uri)
            .and_then(|document| document.diagnostics.clone())
        {
            return Ok(diagnostics);
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(Error::Invalid("LSP diagnostics timed out".into()));
            }
            let frame = match tokio::time::timeout(remaining, self.read_frame()).await {
                Ok(Ok(Some(frame))) => frame,
                Ok(Ok(None)) => return Err(Error::Invalid("LSP server closed".into())),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err(Error::Invalid("LSP diagnostics timed out".into())),
            };
            if frame.get("id").is_some() && frame.get("method").is_some() {
                self.answer_server_request(&frame).await?;
                continue;
            }
            self.retain_diagnostics(&frame);
            if let Some(diagnostics) = self
                .opened
                .get(uri)
                .and_then(|document| document.diagnostics.clone())
            {
                return Ok(diagnostics);
            }
        }
    }
}

struct Server {
    client: Mutex<Client>,
}

pub struct Registry {
    configs: Vec<Config>,
    by_extension: BTreeMap<String, usize>,
    workspace: PathBuf,
    clients: Mutex<BTreeMap<String, Arc<Server>>>,
    children: Mutex<Vec<Child>>,
}

impl Registry {
    pub async fn connect(configs: Vec<Config>, workspace: &Path) -> Result<Self, Error> {
        if configs.len() > 8 {
            return Err(Error::Invalid("LSP server limit".into()));
        }
        let mut by_extension = BTreeMap::new();
        for (index, config) in configs.iter().enumerate() {
            validate_name(&config.name)?;
            if config.argv.is_empty()
                || config.argv.len() > 128
                || config.argv[0].is_empty()
                || config
                    .argv
                    .iter()
                    .any(|arg| arg.contains('\0') || arg.len() > 8192)
                || config.extensions.is_empty()
                || config.extensions.len() > 32
                || config.env.len() > 32
            {
                return Err(Error::Invalid("invalid LSP server configuration".into()));
            }
            for extension in &config.extensions {
                let extension = extension.trim_start_matches('.').to_ascii_lowercase();
                if extension.is_empty()
                    || extension.len() > 16
                    || !extension.bytes().all(|b| b.is_ascii_alphanumeric())
                {
                    return Err(Error::Invalid("invalid LSP extension".into()));
                }
                if by_extension.insert(extension, index).is_some() {
                    return Err(Error::Invalid("duplicate LSP extension".into()));
                }
            }
        }
        Ok(Self {
            configs,
            by_extension,
            workspace: workspace.to_owned(),
            clients: Mutex::new(BTreeMap::new()),
            children: Mutex::new(Vec::new()),
        })
    }

    /// Attach an already-connected transport. Used by tests to inject a
    /// deterministic in-process language server.
    pub async fn connect_io(
        name: String,
        extensions: Vec<String>,
        read: impl AsyncRead + Unpin + Send + 'static,
        write: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Result<Self, Error> {
        validate_name(&name)?;
        let config = Config {
            name: name.clone(),
            argv: vec!["fixture".into()],
            extensions: extensions.clone(),
            env: BTreeMap::new(),
            initialization: None,
        };
        let mut by_extension = BTreeMap::new();
        for extension in &extensions {
            by_extension.insert(
                extension.trim_start_matches('.').to_ascii_lowercase(),
                0usize,
            );
        }
        let mut client = Client::new(read, write);
        client.initialize(&PathBuf::from("."), None).await?;
        let mut clients = BTreeMap::new();
        clients.insert(
            name,
            Arc::new(Server {
                client: Mutex::new(client),
            }),
        );
        Ok(Self {
            configs: vec![config],
            by_extension,
            workspace: PathBuf::from("."),
            clients: Mutex::new(clients),
            children: Mutex::new(Vec::new()),
        })
    }

    fn config_for(&self, path: &Path) -> Option<&Config> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())?;
        self.by_extension
            .get(&extension)
            .and_then(|index| self.configs.get(*index))
    }

    async fn server_for(&self, path: &Path) -> Result<Arc<Server>, Error> {
        let config = self
            .config_for(path)
            .ok_or_else(|| Error::Invalid("no LSP server for this file".into()))?;
        let mut clients = self.clients.lock().await;
        if let Some(server) = clients.get(&config.name) {
            return Ok(server.clone());
        }
        let mut command = Command::new(&config.argv[0]);
        command
            .args(&config.argv[1..])
            .current_dir(&self.workspace)
            .env_clear();
        for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.envs(&config.env);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| Error::Invalid("LSP server could not start".into()))?;
        let read = child
            .stdout
            .take()
            .ok_or_else(|| Error::Invalid("LSP stdout missing".into()))?;
        let write = child
            .stdin
            .take()
            .ok_or_else(|| Error::Invalid("LSP stdin missing".into()))?;
        let mut client = Client::new(read, write);
        tokio::time::timeout(
            Duration::from_secs(15),
            client.initialize(&self.workspace, config.initialization.as_ref()),
        )
        .await
        .map_err(|_| Error::Invalid("LSP initialization timed out".into()))??;
        self.children.lock().await.push(child);
        let server = Arc::new(Server {
            client: Mutex::new(client),
        });
        clients.insert(config.name.clone(), server.clone());
        Ok(server)
    }

    async fn document(&self, path: &Path) -> Result<(Arc<Server>, String, String, String), Error> {
        let server = self.server_for(path).await?;
        let language = self
            .config_for(path)
            .map(|config| config.name.clone())
            .unwrap_or_else(|| "plaintext".into());
        let mut bytes = Vec::new();
        tokio::fs::File::open(path)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 1024 * 1024 {
            return Err(Error::Invalid("LSP target exceeds 1 MiB".into()));
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::Invalid("LSP target must be readable UTF-8".into()))?;
        Ok((server, uri(path)?, language, text))
    }

    /// Prime the server for a file a tool merely read: open the document and
    /// let its first diagnostics land in the cache, so a follow-up edit's
    /// wait is already served. Errors are ignored; warming must never fail the
    /// read that started it.
    pub async fn warm(&self, path: &Path) {
        let _ = self.diagnostics(path).await;
    }

    pub async fn diagnostics(&self, path: &Path) -> Result<Value, ToolError> {
        let (server, uri, language, text) = self
            .document(path)
            .await
            .map_err(|_| ToolError::External("LSP diagnostics failed".into()))?;
        let mut client = server.client.lock().await;
        let diagnostics = client
            .diagnostics(&uri, &language, &text, Duration::from_secs(3))
            .await
            .map_err(|_| ToolError::External("LSP diagnostics failed".into()))?;
        let document = client.opened.get(&uri).ok_or(ToolError::ResourceChanged)?;
        let version = document.version;
        let diagnostics_version = document.diagnostics_version;
        drop(client);
        let sha256 = crate::permission::digest(text.as_bytes());
        // An external writer can change disk content while the server is answering.
        let current_sha256 = self
            .document(path)
            .await
            .ok()
            .map(|(_, _, _, text)| crate::permission::digest(text.as_bytes()));
        let stale = current_sha256.as_ref() != Some(&sha256);
        Ok(json!({
            "diagnostics": if stale { Vec::new() } else { diagnostics },
            "source":{"sha256":sha256,"current_sha256":current_sha256,"document_version":version,
                "diagnostics_version":diagnostics_version,"stale":stale,
                "version_verified": !stale && diagnostics_version == Some(u64::from(version))}
        }))
    }

    pub async fn definition(
        &self,
        path: &Path,
        line: u32,
        character: u32,
    ) -> Result<Value, ToolError> {
        let (server, uri, language, text) = self
            .document(path)
            .await
            .map_err(|_| ToolError::External("LSP definition failed".into()))?;
        let mut client = server.client.lock().await;
        client
            .open(&uri, &language, &text)
            .await
            .map_err(|_| ToolError::External("LSP definition failed".into()))?;
        client
            .request(
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character}}),
                Duration::from_secs(10),
            )
            .await
            .map_err(|_| ToolError::External("LSP definition failed".into()))
    }

    pub async fn references(
        &self,
        path: &Path,
        line: u32,
        character: u32,
    ) -> Result<Value, ToolError> {
        let (server, uri, language, text) = self
            .document(path)
            .await
            .map_err(|_| ToolError::External("LSP references failed".into()))?;
        let mut client = server.client.lock().await;
        client
            .open(&uri, &language, &text)
            .await
            .map_err(|_| ToolError::External("LSP references failed".into()))?;
        client
            .request(
                "textDocument/references",
                json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character},"context":{"includeDeclaration":true}}),
                Duration::from_secs(10),
            )
            .await
            .map_err(|_| ToolError::External("LSP references failed".into()))
    }

    pub async fn query(&self, name: &str, path: &Path, query: Query) -> Result<Value, ToolError> {
        let (server, uri, language, text) = self
            .document(path)
            .await
            .map_err(|_| ToolError::External("LSP document failed".into()))?;
        let mut client = server.client.lock().await;
        client
            .open(&uri, &language, &text)
            .await
            .map_err(|_| ToolError::External("LSP document synchronization failed".into()))?;
        let position = json!({"textDocument":{"uri":uri},"position":{"line":query.line,"character":query.character}});
        let (method, params) = match name {
            "lsp_hover" => ("textDocument/hover", position),
            "lsp_implementation" => ("textDocument/implementation", position),
            "lsp_document_symbols" => (
                "textDocument/documentSymbol",
                json!({"textDocument":{"uri":uri}}),
            ),
            "lsp_workspace_symbols" => ("workspace/symbol", json!({"query":query.query})),
            "lsp_call_hierarchy" | "lsp_incoming_calls" | "lsp_outgoing_calls" => {
                ("textDocument/prepareCallHierarchy", position)
            }
            _ => return Err(ToolError::Unsupported),
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let result = client
            .request(method, params, Duration::from_secs(10))
            .await
            .map_err(|_| ToolError::External(format!("LSP {name} failed")))?;
        if !matches!(name, "lsp_incoming_calls" | "lsp_outgoing_calls") {
            return Ok(result);
        }
        let items = match result {
            Value::Null => return Ok(json!([])),
            Value::Array(items) if items.len() <= 16 => items,
            _ => {
                return Err(ToolError::External(
                    "LSP call hierarchy exceeds item limit".into(),
                ))
            }
        };
        let method = if name == "lsp_incoming_calls" {
            "callHierarchy/incomingCalls"
        } else {
            "callHierarchy/outgoingCalls"
        };
        let mut calls = Vec::new();
        for item in items {
            let result = client
                .request(
                    method,
                    json!({"item":item}),
                    deadline.saturating_duration_since(tokio::time::Instant::now()),
                )
                .await
                .map_err(|_| ToolError::External(format!("LSP {name} failed")))?;
            if let Value::Array(items) = result {
                calls.extend(items);
            }
            if calls.len() > 256 {
                return Err(ToolError::External(
                    "LSP call hierarchy exceeds result limit".into(),
                ));
            }
        }
        if serde_json::to_vec(&calls)
            .map_err(|_| ToolError::InvalidInput)?
            .len()
            > 64 * 1024
        {
            return Err(ToolError::External(
                "LSP call hierarchy exceeds result budget".into(),
            ));
        }
        Ok(Value::Array(calls))
    }

    pub async fn shutdown(&self) {
        for server in self.clients.lock().await.values() {
            let mut client = server.client.lock().await;
            let _ = client
                .send(&json!({"jsonrpc":"2.0","method":"shutdown","id":0}))
                .await;
            let _ = client.send(&json!({"jsonrpc":"2.0","method":"exit"})).await;
        }
        for child in self.children.lock().await.iter_mut() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

fn uri(path: &Path) -> Result<String, Error> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    reqwest::Url::from_file_path(path)
        .map(String::from)
        .map_err(|_| Error::Invalid("invalid LSP file path".into()))
}

fn validate_name(name: &str) -> Result<(), Error> {
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(Error::Invalid(
            "LSP server name must be bounded ASCII".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initialization_options_reach_the_language_server() {
        let (host, server) = tokio::io::duplex(16 * 1024);
        let (read, write) = tokio::io::split(host);
        let mut client = Client::new(read, write);
        let fixture = tokio::spawn(async move {
            let (read, write) = tokio::io::split(server);
            let mut server = Client::new(read, write);
            let frame = server.read_frame().await.unwrap().unwrap();
            assert_eq!(frame["method"], "initialize");
            assert_eq!(
                frame["params"]["initializationOptions"],
                json!({"fixture":true})
            );
            server
                .send(&json!({"jsonrpc":"2.0","id":frame["id"],"result":{"capabilities":{}}}))
                .await
                .unwrap();
            let initialized = server.read_frame().await.unwrap().unwrap();
            assert_eq!(initialized["method"], "initialized");
        });
        client
            .initialize(
                &std::env::current_dir().unwrap(),
                Some(&json!({"fixture":true})),
            )
            .await
            .unwrap();
        fixture.await.unwrap();
    }
}
