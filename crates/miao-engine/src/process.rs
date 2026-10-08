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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Runner {
    workspace: PathBuf,
    cwd: PathBuf,
    temp: PathBuf,
    argv: Vec<String>,
    allow_network: bool,
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
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (workspace, cwd, temp);
        Err("process enforcement is not available on this platform".into())
    }
}

struct Group {
    child: Child,
    pid: u32,
    armed: bool,
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
    if !miao_sandbox::supported() {
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
    let spec = Runner {
        workspace: workspace.into(),
        cwd: cwd.into(),
        temp: temp.path().into(),
        argv: input.argv,
        allow_network,
    };
    let mut command = Command::new(runner);
    command
        .arg("__sandbox-run")
        .arg(serde_json::to_string(&spec).map_err(|_| ToolError::InvalidInput)?)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .current_dir(cwd);
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] {
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
    let child = command.spawn()?;
    let mut group = Group {
        pid: child
            .id()
            .ok_or_else(|| ToolError::Io(std::io::Error::other("child has no pid")))?,
        child,
        armed: true,
    };
    let mut readers = JoinSet::new();
    if let Some(stdout) = group.child.stdout.take() {
        readers.spawn(read_pipe(stdout, true));
    }
    if let Some(stderr) = group.child.stderr.take() {
        readers.spawn(read_pipe(stderr, false));
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
