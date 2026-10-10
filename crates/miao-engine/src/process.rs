use crate::tools::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub argv: Vec<String>,
    #[serde(default = "cwd")]
    pub cwd: String,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    /// Allocate a pseudo-terminal for the child's stdio. Programs that inspect
    /// `isatty` then see a terminal; input is not interactive and stdout/stderr
    /// are merged. Requires the same platform enforcement as the sandbox.
    #[serde(default)]
    pub pty: bool,
}
fn cwd() -> String {
    ".".into()
}
fn timeout() -> u64 {
    10_000
}
impl Input {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if input.argv.is_empty()
            || input.argv.len() > 128
            || input.argv[0].is_empty()
            || input.argv.iter().any(|s| s.contains('\0'))
            || input.argv.iter().map(String::len).sum::<usize>() > 32768
            || !(1..=120_000).contains(&input.timeout_ms)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(input)
    }
}

/// A shell command line run through `bash -c`. Kept separate from [`Input`] so
/// the tool schema stays a shell string rather than an argv array.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BashInput {
    pub command: String,
    #[serde(default = "cwd")]
    pub cwd: String,
    #[serde(default = "timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub pty: bool,
}
impl BashInput {
    pub fn parse(input: Value) -> Result<Self, ToolError> {
        let input: Self = serde_json::from_value(input).map_err(|_| ToolError::InvalidInput)?;
        if input.command.is_empty()
            || input.command.len() > 32768
            || input.command.contains('\0')
            || !(1..=120_000).contains(&input.timeout_ms)
        {
            return Err(ToolError::InvalidInput);
        }
        Ok(input)
    }

    /// Translate to the argv the sandboxed runner executes.
    pub fn argv(&self) -> Vec<String> {
        vec!["bash".into(), "-c".into(), self.command.clone()]
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Runner {
    workspace: PathBuf,
    cwd: PathBuf,
    temp: PathBuf,
    argv: Vec<String>,
    allow_network: bool,
    timeout_ms: u64,
}

/// Whether this engine can actually confine a spawned process. macOS uses
/// seatbelt and Linux uses Landlock; other platforms compile but do not enforce,
/// so the process tools stay disabled there instead of running unsandboxed.
pub fn enforced() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    ))
}

/// Allocate a pseudo-terminal pair with a sane default window size. The master
/// is read by the engine; the slave becomes the guarded child's stdio so that
/// programs observing `isatty` see a terminal.
#[cfg(unix)]
fn open_pty() -> std::io::Result<(std::fs::File, std::fs::File)> {
    use std::os::fd::FromRawFd;
    let mut master = 0;
    let mut slave = 0;
    let mut size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(size),
        )
    };
    if opened != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe {
        (
            std::fs::File::from_raw_fd(master),
            std::fs::File::from_raw_fd(slave),
        )
    })
}
#[cfg(not(unix))]
fn open_pty() -> std::io::Result<(std::fs::File, std::fs::File)> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "pty unsupported",
    ))
}

/// Read the master side of a pty. Linux reports end-of-input from a pty master
/// as `EIO` rather than a zero-length read; both are treated as end-of-stream.
async fn read_pty(master: std::fs::File) -> Result<(bool, Vec<u8>), ToolError> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut master = master;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match master.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    bytes.extend_from_slice(&buffer[..read]);
                    if bytes.len() > 32768 {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    if error.raw_os_error() == Some(libc::EIO) {
                        break;
                    }
                    return Err(ToolError::Io(error));
                }
            }
        }
        Ok((true, bytes))
    })
    .await
    .map_err(|_| ToolError::Io(std::io::Error::other("pty reader failed")))?
}

/// The binary calls this before constructing Tokio: Linux confinement must be
/// applied to a fresh single-threaded process, not a provider/runtime thread.
pub fn sandbox_runner(payload: &str) -> Result<(), Box<dyn std::error::Error>> {
    if payload.len() > 65536 {
        return Err("sandbox payload exceeds limit".into());
    }
    let spec: Runner = serde_json::from_str(payload)?;
    if spec.argv.is_empty() || spec.argv.iter().any(|s| s.contains('\0')) {
        return Err("invalid runner argv".into());
    }
    let workspace = std::fs::canonicalize(&spec.workspace)?;
    let cwd = std::fs::canonicalize(&spec.cwd)?;
    let temp = std::fs::canonicalize(&spec.temp)?;
    if !cwd.starts_with(&workspace) || !cwd.is_dir() || !temp.is_dir() {
        return Err("invalid runner placement".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let profile = miao_sandbox::profile(&[workspace, temp], &[], spec.allow_network, false);
        let error = std::process::Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--"])
            .args(&spec.argv)
            .current_dir(cwd)
            .exec();
        Err(error.into())
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        miao_sandbox::apply_linux_strict(&[workspace, temp], spec.allow_network)
            .map_err(std::io::Error::other)?;
        let error = std::process::Command::new(&spec.argv[0])
            .args(&spec.argv[1..])
            .current_dir(cwd)
            .exec();
        Err(error.into())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = cwd;
        let workdirs = vec![workspace.clone(), temp.clone()];
        let code = miao_sandbox::win::run(&workdirs, &[], spec.allow_network, &spec.argv).map_err(
            |error| -> Box<dyn std::error::Error> {
                let message = match error {
                    miao_sandbox::win::WinError::Unavailable(message) => message,
                    miao_sandbox::win::WinError::Start(message) => message,
                };
                Box::new(std::io::Error::other(message))
            },
        )?;
        std::process::exit(code);
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (workspace, cwd, temp);
        Err("process enforcement is not available on this platform".into())
    }
}

#[cfg(unix)]
static GUARDIAN_TERMINATE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn guardian_signal(_: libc::c_int) {
    GUARDIAN_TERMINATE.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// A small synchronous guardian retains a private stdin lifeline. Parent hard
/// exit closes the pipe and kills the entire ordinary process group, even when
/// Rust destructors cannot run. User command stdin remains /dev/null.
#[cfg(unix)]
pub fn guardian(payload: &str) -> Result<(), Box<dyn std::error::Error>> {
    if payload.len() > 65536 {
        return Err("guardian payload exceeds limit".into());
    }
    let spec: Runner = serde_json::from_str(payload)?;
    let group = unsafe { libc::getpgrp() };
    if group != unsafe { libc::getpid() } {
        return Err("guardian requires its own process group".into());
    }
    struct FailureGuard {
        group: i32,
    }
    impl Drop for FailureGuard {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-self.group, libc::SIGKILL);
            }
        }
    }
    let _guard = FailureGuard { group };
    unsafe {
        libc::signal(
            libc::SIGTERM,
            guardian_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            guardian_signal as *const () as libc::sighandler_t,
        );
    }
    let mut child = std::process::Command::new(std::env::current_exe()?)
        .args(["__sandbox-run", payload])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let deadline =
        std::time::Instant::now() + Duration::from_millis(spec.timeout_ms.saturating_add(1000));
    let mut terminated = None;
    let mut completed = None;
    loop {
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        let polled = unsafe { libc::poll(&mut fd, 1, 25) };
        if polled < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(std::io::Error::last_os_error().into());
        }
        if fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
            return Err("guardian lost its owner".into());
        }
        if fd.revents & libc::POLLIN != 0 {
            let mut byte = 0u8;
            if unsafe { libc::read(0, (&mut byte as *mut u8).cast(), 1) } <= 0 {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                return Err("guardian lost its owner".into());
            }
        }
        if completed.is_none() {
            completed = child.try_wait()?;
        }
        if terminated.is_none()
            && (completed.is_some()
                || GUARDIAN_TERMINATE.load(std::sync::atomic::Ordering::Relaxed)
                || std::time::Instant::now() >= deadline)
        {
            terminated = Some(std::time::Instant::now());
            unsafe {
                libc::kill(-group, libc::SIGTERM);
            }
        }
        if terminated.is_some_and(|time| time.elapsed() >= Duration::from_millis(150)) {
            if let Some(status) = completed {
                use std::os::unix::process::ExitStatusExt;
                // The engine remains responsible for the final SIGKILL sweep.
                // Parent-loss detection above remains active during grace.
                std::process::exit(status.code().unwrap_or(128 + status.signal().unwrap_or(1)));
            }
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
            return Err("guardian deadline exceeded".into());
        }
    }
}
#[cfg(not(unix))]
pub fn guardian(_: &str) -> Result<(), Box<dyn std::error::Error>> {
    Err("process guardian unsupported".into())
}

struct Group {
    child: Child,
    pid: u32,
    armed: bool,
    _lifeline: Option<tokio::process::ChildStdin>,
}
impl Group {
    #[cfg(unix)]
    fn signal(&self, signal: i32) {
        unsafe {
            libc::kill(-(self.pid as i32), signal);
        }
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.armed {
            self.signal(libc::SIGKILL);
        }
        let _ = self.child.start_kill();
    }
}

/// Foreground process ownership. No detached/background process API is implied.
/// A cancelled task still kills/reaps its group and joins pipe readers.
pub(crate) async fn execute(
    runner: &Path,
    workspace: &Path,
    cwd: &Path,
    input: Input,
    allow_network: bool,
    cancel: CancellationToken,
) -> Result<Value, ToolError> {
    if !enforced() {
        return Err(ToolError::Unsupported);
    }
    if cancel.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let temp = tokio::task::spawn_blocking(tempfile::tempdir)
        .await
        .map_err(|_| ToolError::Io(std::io::Error::other("temp worker failed")))??;
    if cancel.is_cancelled() {
        return Err(ToolError::Interrupted);
    }
    let pty = input.pty;
    let spec = Runner {
        workspace: workspace.into(),
        cwd: cwd.into(),
        temp: temp.path().into(),
        argv: input.argv,
        allow_network,
        timeout_ms: input.timeout_ms,
    };
    // On Windows the AppContainer runner is spawned directly: it owns a job
    // object whose child tree dies with it, so no guardian/lifeline is needed.
    #[cfg(unix)]
    let runner_mode = "__process-guardian";
    #[cfg(windows)]
    let runner_mode = "__sandbox-run";
    let mut command = Command::new(runner);
    command
        .arg(runner_mode)
        .arg(serde_json::to_string(&spec).map_err(|_| ToolError::InvalidInput)?)
        .env_clear()
        .kill_on_drop(true)
        .current_dir(cwd);
    #[cfg(unix)]
    command.stdin(Stdio::piped());
    #[cfg(windows)]
    command.stdin(Stdio::null());
    let master = if pty {
        let (master, slave) = open_pty()?;
        command.stdout(Stdio::from(slave.try_clone()?));
        command.stderr(Stdio::from(slave));
        Some(master)
    } else {
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        None
    };
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    // Windows needs its core environment for CreateProcessW and for `cmd` to
    // resolve; a cleared environment makes the AppContainer spawn fail.
    #[cfg(windows)]
    for key in [
        "SystemRoot",
        "windir",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "OS",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("TMPDIR", temp.path())
        .env("TMP", temp.path())
        .env("TEMP", temp.path());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn()?;
    // A `Stdio::from(File)` slave can outlive `spawn` inside the Command; drop
    // it so the parent holds no pty slave, or the master would never reach EOF.
    drop(command);
    let lifeline = child.stdin.take();
    let mut group = Group {
        pid: child
            .id()
            .ok_or_else(|| ToolError::Io(std::io::Error::other("child has no pid")))?,
        child,
        armed: true,
        _lifeline: lifeline,
    };
    let mut readers = JoinSet::new();
    if let Some(master) = master {
        readers.spawn(read_pty(master));
    } else {
        if let Some(stdout) = group.child.stdout.take() {
            readers.spawn(read_pipe(stdout, true));
        }
        if let Some(stderr) = group.child.stderr.take() {
            readers.spawn(read_pipe(stderr, false));
        }
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut status = None;
    let mut reason = "completed";
    let deadline = tokio::time::Instant::now() + Duration::from_millis(input.timeout_ms);
    loop {
        if status.is_some() && readers.is_empty() {
            break;
        }
        tokio::select! {
            _=cancel.cancelled()=>{reason="cancelled";break;},
            _=tokio::time::sleep_until(deadline)=>{reason="timed_out";break;},
            exit=group.child.wait(),if status.is_none()=>{
                status=Some(exit?);
                #[cfg(unix)] group.signal(libc::SIGTERM);
            },
            part=readers.join_next(),if !readers.is_empty()=>{
                if let Some(part)=part {
                    let (is_stdout,bytes)=part.map_err(|_|ToolError::Io(std::io::Error::other("pipe reader failed")))??;
                    let oversized=bytes.len()>32768;
                    if is_stdout{stdout=bytes;}else{stderr=bytes;}
                    if oversized{reason="output_limit";break;}
                }
            },
        }
    }
    #[cfg(unix)]
    group.signal(libc::SIGTERM);
    if status.is_none() {
        if let Ok(exit) = tokio::time::timeout(Duration::from_millis(250), group.child.wait()).await
        {
            status = Some(exit?);
        }
    }
    #[cfg(unix)]
    group.signal(libc::SIGKILL);
    if status.is_none() {
        let _ = group.child.start_kill();
        status = Some(group.child.wait().await?);
    }
    // A deliberately re-sessioned descendant may keep a pipe open; never let
    // output collection hang the control path. Such escapes need cgroup/Job
    // ownership in a later backend; sandbox restrictions remain inherited.
    let drained = tokio::time::timeout(Duration::from_millis(500), async {
        while let Some(part) = readers.join_next().await {
            let (is_stdout, bytes) =
                part.map_err(|_| ToolError::Io(std::io::Error::other("pipe reader failed")))??;
            if bytes.len() > 32768 && reason == "completed" {
                reason = "output_limit";
            }
            if is_stdout {
                stdout = bytes;
            } else {
                stderr = bytes;
            }
        }
        Ok::<_, ToolError>(())
    })
    .await;
    let output_incomplete = drained.is_err();
    if let Ok(result) = drained {
        result?;
    }
    readers.abort_all();
    while readers.join_next().await.is_some() {}
    stdout.truncate(32768);
    stderr.truncate(32768);
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.as_ref().and_then(|s| s.signal())
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    let exit_code = status.and_then(|s| s.code());
    group.armed = false;
    Ok(
        json!({"stdout":String::from_utf8_lossy(&stdout),"stderr":String::from_utf8_lossy(&stderr),"exit_code":exit_code,"signal":signal,"pid":group.pid,"reason":reason,"output_incomplete":output_incomplete,"sandbox_profile":"workspace_write","enforcement_required":true,"network_allowed":allow_network}),
    )
}

async fn read_pipe(
    stream: impl AsyncRead + Unpin,
    is_stdout: bool,
) -> Result<(bool, Vec<u8>), ToolError> {
    let mut bytes = Vec::new();
    stream.take(32769).read_to_end(&mut bytes).await?;
    Ok((is_stdout, bytes))
}
