use crate::{protocol::Error, tools::ToolError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
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
}

/// A parsed `lsp_*` tool input.
pub struct Query {
    pub path: String,
    pub line: u32,
    pub character: u32,
}
impl Query {
    pub fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Position {
            path: String,
            #[serde(default)]
            line: u32,
            #[serde(default)]
            character: u32,
        }
        let parsed: Position =
            serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if parsed.path.is_empty() || parsed.path.len() > 4096 {
            return Err(ToolError::InvalidInput);
        }
        if name != "lsp_diagnostics" && (parsed.line > 10_000_000 || parsed.character > 10_000_000)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(Self {
            path: parsed.path,
            line: parsed.line,
            character: parsed.character,
        })
    }
}

struct Client {
    read: BufReader<Box<dyn AsyncRead + Unpin + Send>>,
    write: Box<dyn AsyncWrite + Unpin + Send>,
    next: u64,
    initialized: bool,
    opened: BTreeSet<String>,
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
            opened: BTreeSet::new(),
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

    async fn initialize(&mut self, root: &Path) -> Result<(), Error> {
        if self.initialized {
            return Ok(());
        }
        let id = self.next;
        self.next += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{"processId":null,"rootUri":format!("file://{}", root.display()),"capabilities":{}}})).await?;
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
        if self.opened.insert(uri.to_owned()) {
            self.send(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":language,"version":1,"text":text}}})).await?;
        }
        Ok(())
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
            if frame.get("id") == Some(&json!(id)) {
                if frame.get("error").is_some() {
                    return Err(Error::Invalid(format!("LSP {method} failed")));
                }
                return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
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
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(Vec::new());
            }
            let frame = match tokio::time::timeout(remaining, self.read_frame()).await {
                Ok(Ok(Some(frame))) => frame,
                Ok(Ok(None)) | Ok(Err(_)) | Err(_) => return Ok(Vec::new()),
            };
            if frame.get("id").is_some() && frame.get("method").is_some() {
                self.answer_server_request(&frame).await?;
                continue;
            }
            if frame["method"] == "textDocument/publishDiagnostics" && frame["params"]["uri"] == uri
            {
                let diagnostics = frame["params"]["diagnostics"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                return Ok(diagnostics.into_iter().take(256).collect());
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
        };
        let mut by_extension = BTreeMap::new();
        for extension in &extensions {
            by_extension.insert(
                extension.trim_start_matches('.').to_ascii_lowercase(),
                0usize,
            );
        }
        let mut client = Client::new(read, write);
        client.initialize(&PathBuf::from(".")).await?;
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
        if let Some(server) = self.clients.lock().await.get(&config.name) {
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
        tokio::time::timeout(Duration::from_secs(15), client.initialize(&self.workspace))
            .await
            .map_err(|_| Error::Invalid("LSP initialization timed out".into()))??;
        self.children.lock().await.push(child);
        let server = Arc::new(Server {
            client: Mutex::new(client),
        });
        self.clients
            .lock()
            .await
            .insert(config.name.clone(), server.clone());
        Ok(server)
    }

    async fn document(&self, path: &Path) -> Result<(Arc<Server>, String, String, String), Error> {
        let server = self.server_for(path).await?;
        let language = self
            .config_for(path)
            .map(|config| config.name.clone())
            .unwrap_or_else(|| "plaintext".into());
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|_| Error::Invalid("LSP target must be readable UTF-8".into()))?;
        if text.len() > 1024 * 1024 {
            return Err(Error::Invalid("LSP target exceeds 1 MiB".into()));
        }
        Ok((server, uri(path), language, text))
    }

    pub async fn diagnostics(&self, path: &Path) -> Result<Value, ToolError> {
        let (server, uri, language, text) = self
            .document(path)
            .await
            .map_err(|_| ToolError::External("LSP diagnostics failed".into()))?;
        let diagnostics = server
            .client
            .lock()
            .await
            .diagnostics(&uri, &language, &text, Duration::from_secs(3))
            .await
            .map_err(|_| ToolError::External("LSP diagnostics failed".into()))?;
        Ok(json!({"diagnostics": diagnostics}))
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

fn uri(path: &Path) -> String {
    format!("file://{}", path.display())
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
