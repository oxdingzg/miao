use crate::tools::ToolError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub argv: Vec<String>,
    #[serde(default = "cwd")]
    pub cwd: String,
    #[serde(default = "rows")]
    pub rows: u16,
    #[serde(default = "cols")]
    pub cols: u16,
}
fn cwd() -> String {
    ".".into()
}
fn rows() -> u16 {
    24
}
fn cols() -> u16 {
    80
}
impl Start {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        crate::process::Input::parse(json!({"argv":input.argv,"cwd":input.cwd}))?;
        validate_size(input.rows, input.cols)?;
        Ok(input)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    pub id: String,
    pub input: Option<String>,
    pub cursor: Option<u64>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}
impl Control {
    pub fn parse(name: &str, input: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if input.id.is_empty()
            || input.id.len() > 128
            || name != "terminal_write" && input.input.is_some()
            || name != "terminal_read" && input.cursor.is_some()
            || name != "terminal_resize" && (input.rows.is_some() || input.cols.is_some())
        {
            return Err(ToolError::InvalidInput);
        }
        if name == "terminal_write" && input.input.as_ref().is_none_or(|value| value.len() > 32768)
        {
            return Err(ToolError::InvalidInput);
        }
        if name == "terminal_resize" {
            validate_size(
                input.rows.ok_or(ToolError::InvalidInput)?,
                input.cols.ok_or(ToolError::InvalidInput)?,
            )?;
        }
        Ok(input)
    }
}
fn validate_size(rows: u16, cols: u16) -> Result<(), ToolError> {
    if !(1..=500).contains(&rows) || !(1..=500).contains(&cols) {
        return Err(ToolError::InvalidInput);
    }
    Ok(())
}

pub fn supported() -> bool {
    crate::process::enforced()
}

#[derive(Default)]
struct Output {
    bytes: std::collections::VecDeque<u8>,
    offset: u64,
    cursor: u64,
    exit: Option<Value>,
}
impl Output {
    fn append(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes);
        if self.bytes.len() > 1024 * 1024 {
            let excess = self.bytes.len() - 1024 * 1024;
            self.bytes.drain(..excess);
            self.offset += excess as u64;
        }
    }
    fn read(&mut self, id: &str, cursor: Option<u64>) -> Result<Value, ToolError> {
        let requested = cursor.unwrap_or(self.cursor);
        let end = self.offset + self.bytes.len() as u64;
        if requested > end {
            return Err(ToolError::InvalidInput);
        }
        let start = requested.max(self.offset);
        let bytes: Vec<u8> = self
            .bytes
            .iter()
            .skip((start - self.offset) as usize)
            .take(32768)
            .copied()
            .collect();
        let next = start + bytes.len() as u64;
        self.cursor = next;
        Ok(
            json!({"id":id,"output":String::from_utf8_lossy(&bytes),"cursor":next,"retained_from":self.offset,"dropped":start - requested,"truncated":next < end,"exit":self.exit}),
        )
    }
}

struct Terminal {
    output: Arc<std::sync::Mutex<Output>>,
    cancel: CancellationToken,
    join: Mutex<Option<tokio::task::JoinHandle<()>>>,
    #[cfg(unix)]
    commands: tokio::sync::mpsc::Sender<Command>,
    #[cfg(windows)]
    pty: Arc<std::sync::Mutex<miao_sandbox::pty::Pty>>,
}
impl Terminal {
    /// Cancel the terminal's worker and wait for it to reap its process tree.
    /// On Windows the worker is blocked on the pseudoconsole output pipe, so the
    /// tree is killed first to make the read return end-of-stream.
    async fn reap(&self) {
        self.cancel.cancel();
        #[cfg(windows)]
        {
            let pty = self.pty.clone();
            let _ = tokio::task::spawn_blocking(move || pty.lock().unwrap().kill()).await;
        }
        if let Some(join) = self.join.lock().await.take() {
            let _ = join.await;
        }
    }
}
#[cfg(unix)]
enum Command {
    Write(String, tokio::sync::oneshot::Sender<Result<(), ToolError>>),
    Resize(
        u16,
        u16,
        tokio::sync::oneshot::Sender<Result<(), ToolError>>,
    ),
}

#[derive(Default)]
pub struct Registry {
    terminals: Mutex<BTreeMap<(String, String), Arc<Terminal>>>,
    stop: CancellationToken,
}
impl Drop for Registry {
    fn drop(&mut self) {
        self.stop.cancel();
        // On Windows the worker is blocked on the pseudoconsole output pipe, so
        // cancelling the token alone cannot wake it. Kill each tree here too, or
        // a runtime shutdown would wait forever on a reader that never returns.
        #[cfg(windows)]
        {
            if let Ok(terminals) = self.terminals.try_lock() {
                for terminal in terminals.values() {
                    if let Ok(mut pty) = terminal.pty.lock() {
                        pty.kill();
                    }
                }
            }
        }
    }
}
impl Registry {
    #[cfg(unix)]
    pub async fn start(
        &self,
        session: &str,
        runner: &Path,
        workspace: &Path,
        cwd: &Path,
        input: Start,
        network: bool,
    ) -> Result<Value, ToolError> {
        use std::os::fd::AsRawFd;
        if self.stop.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        let mut terminals = self.terminals.lock().await;
        if terminals.len() >= 32
            || terminals
                .keys()
                .filter(|(owner, _)| owner == session)
                .count()
                >= 8
        {
            return Err(ToolError::External(
                "terminal limit reached; stop an existing terminal".into(),
            ));
        }
        let (mut group, master, temp) = crate::process::spawn(
            runner,
            workspace,
            cwd,
            input.argv,
            86_400_000,
            true,
            true,
            network,
            &[],
        )
        .await?;
        let master = master.ok_or(ToolError::Unsupported)?;
        unsafe {
            let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFL);
            if flags < 0
                || libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) < 0
            {
                return Err(ToolError::Io(std::io::Error::last_os_error()));
            }
        }
        resize(&master, input.rows, input.cols)?;
        let master = tokio::io::unix::AsyncFd::new(master)?;
        let id = format!("term_{}", uuid::Uuid::new_v4());
        let output = Arc::new(std::sync::Mutex::new(Output::default()));
        let captured = output.clone();
        let cancel = self.stop.child_token();
        let lifetime = cancel.clone();
        let (commands, mut receive) = tokio::sync::mpsc::channel(8);
        let join = tokio::spawn(async move {
            let _temp = temp;
            let mut buffer = [0u8; 8192];
            let mut eof = false;
            let mut status = None;
            let mut reason = "completed";
            let mut failure = None;
            loop {
                tokio::select! {
                    _ = lifetime.cancelled() => { reason = "stopped"; break; }
                    exit = group.child.wait() => {
                        match exit { Ok(exit) => status = Some(exit), Err(error) => failure = Some(error.to_string()) }
                        break;
                    }
                    read = read_master(&master, &mut buffer), if !eof => match read {
                        Ok(0) => eof = true,
                        Ok(size) => captured.lock().unwrap().append(&buffer[..size]),
                        Err(error) if error.raw_os_error() == Some(libc::EIO) => eof = true,
                        Err(error) => { failure = Some(error.to_string()); break; }
                    },
                    command = receive.recv() => match command {
                        Some(Command::Write(input, reply)) => {
                            let result = tokio::select! {
                                _ = lifetime.cancelled() => Err(ToolError::Interrupted),
                                result = tokio::time::timeout(std::time::Duration::from_secs(1), write_master(&master, input.as_bytes())) => match result {
                                    Ok(result) => result.map_err(ToolError::Io),
                                    Err(_) => Err(ToolError::External("terminal input timed out; some bytes may have been written".into())),
                                }
                            };
                            let _ = reply.send(result);
                        }
                        Some(Command::Resize(rows, cols, reply)) => { let _ = reply.send(resize(master.get_ref(), rows, cols)); }
                        None => { reason = "stopped"; break; }
                    }
                }
            }
            group.signal(libc::SIGTERM);
            if status.is_none() {
                if let Ok(Ok(exit)) =
                    tokio::time::timeout(std::time::Duration::from_millis(250), group.child.wait())
                        .await
                {
                    status = Some(exit);
                }
            }
            group.signal(libc::SIGKILL);
            if status.is_none() {
                let _ = group.child.start_kill();
                // On macOS a dying controlling-terminal owner can remain in
                // kernel exit while queued output awaits a master reader.
                // Reaping and draining must overlap, including after SIGKILL.
                loop {
                    tokio::select! {
                        biased;
                        exit = group.child.wait() => { status = exit.ok(); break; }
                        read = read_master(&master, &mut buffer), if !eof => match read {
                            Ok(0) => eof = true,
                            Ok(size) => captured.lock().unwrap().append(&buffer[..size]),
                            Err(_) => eof = true,
                        }
                    }
                }
            }
            // Drain only already available bytes after reaping; escaped slave
            // holders cannot keep shutdown or terminal_stop waiting forever.
            for _ in 0..128 {
                let read = unsafe {
                    libc::read(
                        master.get_ref().as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if read <= 0 {
                    break;
                }
                captured.lock().unwrap().append(&buffer[..read as usize]);
            }
            use std::os::unix::process::ExitStatusExt;
            captured.lock().unwrap().exit = Some(
                json!({"reason":reason,"exit_code":status.as_ref().and_then(|exit| exit.code()),"signal":status.as_ref().and_then(|exit| exit.signal()),"error":failure}),
            );
            group.armed = false;
            drop(group);
        });
        terminals.insert(
            (session.into(), id.clone()),
            Arc::new(Terminal {
                output,
                cancel,
                join: Mutex::new(Some(join)),
                commands,
            }),
        );
        Ok(
            json!({"id":id,"rows":input.rows,"cols":input.cols,"sandbox_profile":"workspace_write","network_allowed":network,"max_lifetime_ms":86400000}),
        )
    }

    /// Windows terminals run a real pseudoconsole (ConPTY). The child is placed
    /// in the shared AppContainer/job sandbox. A failed confined launch is
    /// reported as an error, without retrying in a wider security context.
    #[cfg(windows)]
    pub async fn start(
        &self,
        session: &str,
        _runner: &Path,
        workspace: &Path,
        cwd: &Path,
        input: Start,
        network: bool,
    ) -> Result<Value, ToolError> {
        if self.stop.is_cancelled() {
            return Err(ToolError::Interrupted);
        }
        let mut terminals = self.terminals.lock().await;
        if terminals.len() >= 32
            || terminals
                .keys()
                .filter(|(owner, _)| owner == session)
                .count()
                >= 8
        {
            return Err(ToolError::External(
                "terminal limit reached; stop an existing terminal".into(),
            ));
        }
        let Start {
            argv, rows, cols, ..
        } = input;
        let temp = tokio::task::spawn_blocking(tempfile::tempdir)
            .await
            .map_err(|_| ToolError::Io(std::io::Error::other("temp worker failed")))?
            .map_err(ToolError::Io)?;
        let spec = miao_sandbox::pty::Spec {
            argv,
            cwd: cwd.to_path_buf(),
            writable: vec![workspace.to_path_buf(), temp.path().to_path_buf()],
            temp: temp.path().to_path_buf(),
            allow_network: network,
            rows,
            cols,
        };
        let pty = miao_sandbox::pty::Pty::spawn(spec).map_err(|error| {
            let message = match error {
                miao_sandbox::win::WinError::Unavailable(message)
                | miao_sandbox::win::WinError::Start(message) => message,
            };
            ToolError::External(message)
        })?;
        let confined = pty.confined();
        let reader = pty.try_clone_reader().map_err(ToolError::Io)?;
        let id = format!("term_{}", uuid::Uuid::new_v4());
        let output = Arc::new(std::sync::Mutex::new(Output::default()));
        let captured = output.clone();
        let cancel = self.stop.child_token();
        let lifetime = cancel.clone();
        let control = Arc::new(std::sync::Mutex::new(pty));
        let worker_control = control.clone();
        let join = tokio::task::spawn_blocking(move || {
            let _temp = temp;
            let mut reader = reader;
            let mut buffer = [0u8; 8192];
            let mut failure = None;
            loop {
                if lifetime.is_cancelled() {
                    break;
                }
                match reader.read_timeout(&mut buffer, std::time::Duration::from_millis(100)) {
                    Ok(Some(0)) => break,
                    Ok(Some(size)) => captured.lock().unwrap().append(&buffer[..size]),
                    Ok(None) => {}
                    Err(error) => {
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }
            let mut guard = worker_control.lock().unwrap();
            guard.kill();
            let status = guard.poll_exit().ok().flatten();
            let reason = if lifetime.is_cancelled() {
                "stopped"
            } else {
                "completed"
            };
            captured.lock().unwrap().exit = Some(
                json!({"reason":reason,"exit_code":status,"signal":Value::Null,"error":failure}),
            );
        });
        terminals.insert(
            (session.into(), id.clone()),
            Arc::new(Terminal {
                output,
                cancel,
                join: Mutex::new(Some(join)),
                pty: control,
            }),
        );
        Ok(json!({
            "id": id,
            "rows": rows,
            "cols": cols,
            "sandbox_profile": if confined { "workspace_write" } else { "windows_unconfined" },
            "network_allowed": network,
            "max_lifetime_ms": 86400000
        }))
    }

    #[cfg(not(any(unix, windows)))]
    pub async fn start(
        &self,
        _: &str,
        _: &Path,
        _: &Path,
        _: &Path,
        _: Start,
        _: bool,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Unsupported)
    }

    pub async fn execute(
        &self,
        session: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, ToolError> {
        if name == "terminal_list" {
            let terminals = self.terminals.lock().await;
            let mut list = Vec::new();
            for ((_, id), terminal) in terminals.iter().filter(|((owner, _), _)| owner == session) {
                list.push(json!({"id":id,"exit":terminal.output.lock().unwrap().exit}));
            }
            return Ok(json!({"terminals":list}));
        }
        let input = Control::parse(name, input)?;
        let terminal = self
            .terminals
            .lock()
            .await
            .get(&(session.into(), input.id.clone()))
            .cloned()
            .ok_or_else(|| ToolError::External("terminal not found in this Session".into()))?;
        match name {
            "terminal_read" => terminal
                .output
                .lock()
                .unwrap()
                .read(&input.id, input.cursor),
            "terminal_stop" => {
                terminal.reap().await;
                self.terminals
                    .lock()
                    .await
                    .remove(&(session.into(), input.id.clone()));
                terminal
                    .output
                    .lock()
                    .unwrap()
                    .read(&input.id, input.cursor)
            }
            #[cfg(windows)]
            "terminal_write" | "terminal_resize" => {
                if terminal.output.lock().unwrap().exit.is_some() {
                    return Err(ToolError::External("terminal has exited".into()));
                }
                let pty = terminal.pty.clone();
                let result = if name == "terminal_write" {
                    let text = input.input.unwrap();
                    tokio::task::spawn_blocking(move || pty.lock().unwrap().write(text.as_bytes()))
                        .await
                        .map_err(|_| {
                            ToolError::Io(std::io::Error::other("terminal write worker failed"))
                        })?
                } else {
                    let (rows, cols) = (input.rows.unwrap(), input.cols.unwrap());
                    tokio::task::spawn_blocking(move || pty.lock().unwrap().resize(rows, cols))
                        .await
                        .map_err(|_| {
                            ToolError::Io(std::io::Error::other("terminal resize worker failed"))
                        })?
                };
                result.map_err(ToolError::Io)?;
                Ok(json!({"id":input.id,"accepted":true}))
            }
            #[cfg(unix)]
            "terminal_write" | "terminal_resize" => {
                if terminal.output.lock().unwrap().exit.is_some() {
                    return Err(ToolError::External("terminal has exited".into()));
                }
                let (reply, result) = tokio::sync::oneshot::channel();
                let command = if name == "terminal_write" {
                    Command::Write(input.input.unwrap(), reply)
                } else {
                    Command::Resize(input.rows.unwrap(), input.cols.unwrap(), reply)
                };
                terminal
                    .commands
                    .send(command)
                    .await
                    .map_err(|_| ToolError::External("terminal has exited".into()))?;
                result
                    .await
                    .map_err(|_| ToolError::External("terminal has exited".into()))??;
                Ok(json!({"id":input.id,"accepted":true}))
            }
            _ => Err(ToolError::Unsupported),
        }
    }

    pub async fn shutdown(&self) {
        self.stop.cancel();
        let terminals = std::mem::take(&mut *self.terminals.lock().await);
        for terminal in terminals.into_values() {
            terminal.reap().await;
        }
    }
}

#[cfg(unix)]
fn resize(master: &std::fs::File, rows: u16, cols: u16) -> Result<(), ToolError> {
    use std::os::fd::AsRawFd;
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        return Err(ToolError::Io(std::io::Error::last_os_error()));
    }
    Ok(())
}
#[cfg(unix)]
async fn read_master(
    master: &tokio::io::unix::AsyncFd<std::fs::File>,
    buffer: &mut [u8],
) -> std::io::Result<usize> {
    use std::os::fd::AsRawFd;
    loop {
        let mut ready = master.readable().await?;
        match ready.try_io(|fd| {
            let read = unsafe {
                libc::read(
                    fd.get_ref().as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if read < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(read as usize)
        }) {
            Ok(result) => return result,
            Err(_) => continue,
        }
    }
}
#[cfg(unix)]
async fn write_master(
    master: &tokio::io::unix::AsyncFd<std::fs::File>,
    mut bytes: &[u8],
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    while !bytes.is_empty() {
        let mut ready = master.writable().await?;
        match ready.try_io(|fd| {
            let written = unsafe {
                libc::write(fd.get_ref().as_raw_fd(), bytes.as_ptr().cast(), bytes.len())
            };
            if written < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(written as usize)
        }) {
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "terminal write returned zero",
                ))
            }
            Ok(Ok(size)) => bytes = &bytes[size..],
            Ok(Err(error)) => return Err(error),
            Err(_) => continue,
        }
    }
    Ok(())
}
