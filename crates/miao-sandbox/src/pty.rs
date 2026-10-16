//! Windows pseudoconsole (ConPTY) backend.
//!
//! Provides a real interactive terminal: a pair of pipes plus
//! `CreatePseudoConsole`, with the child started inside the same AppContainer
//! and job object `win.rs` uses for foreground commands, so the whole tree dies
//! with the terminal.
//!
//! The child requires AppContainer confinement. If the OS rejects the combined
//! launch, startup fails rather than falling back to a wider security context.

use std::ffi::{c_void, OsStr};
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, LocalFree, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE, HANDLE,
    HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows::Win32::Security::{PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::JobObjects::{AssignProcessToJobObject, TerminateJobObject};
use windows::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::win::{
    capability_sid, command_line, grant_console_objects, grant_modify, grant_path_discovery,
    last_error, new_container, new_job, Container, Grants, WinError,
};

/// Everything needed to start one interactive pseudoconsole session.
pub struct Spec {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    /// Directories granted Modify to the confined child (workspace + temp).
    pub writable: Vec<PathBuf>,
    /// Scratch directory advertised as TMP/TEMP/TMPDIR inside the session.
    pub temp: PathBuf,
    pub allow_network: bool,
    pub rows: u16,
    pub cols: u16,
}

/// A live pseudoconsole session. Dropping it kills the job (and therefore the
/// whole process tree) and closes the pseudoconsole.
pub struct Pty {
    console: HPCON,
    /// Pipe ends handed to the pseudoconsole. The console owns their use, but
    /// the process must keep the handles open for the console's lifetime:
    /// closing them immediately leaves the child with a dead console (its
    /// output never reaches the read pipe). Released in `Drop`, after the
    /// console is closed.
    pty_input: HANDLE,
    pty_output: HANDLE,
    input: std::fs::File,
    output: std::fs::File,
    process: HANDLE,
    job: HANDLE,
    pid: u32,
    exit: Option<i32>,
    confined: bool,
    _grants: Grants,
    _container: Option<Container>,
}

// The handles are kernel objects valid process-wide; every access is either on
// the owning thread or serialized behind a Mutex. The raw `HANDLE` newtype is
// not `Send` on its own, so state it explicitly.
unsafe impl Send for Pty {}

impl Pty {
    /// Create a pseudoconsole and start `spec.argv` inside an AppContainer.
    /// Failure to establish confinement is returned to the caller.
    pub fn spawn(spec: Spec) -> Result<Pty, WinError> {
        let job = new_job()?;
        let (input_read, input_write) = match create_pipe() {
            Ok(pair) => pair,
            Err(error) => {
                unsafe {
                    let _ = CloseHandle(job);
                }
                return Err(error);
            }
        };
        let (output_read, output_write) = match create_pipe() {
            Ok(pair) => pair,
            Err(error) => {
                unsafe {
                    let _ = CloseHandle(input_read);
                    let _ = CloseHandle(input_write);
                    let _ = CloseHandle(job);
                }
                return Err(error);
            }
        };
        let size = COORD {
            X: spec.cols as i16,
            Y: spec.rows as i16,
        };
        let console = match unsafe { CreatePseudoConsole(size, input_read, output_write, 0) } {
            Ok(console) => console,
            Err(error) => {
                unsafe {
                    for handle in [input_read, input_write, output_read, output_write, job] {
                        let _ = CloseHandle(handle);
                    }
                }
                return Err(WinError::Start(format!(
                    "CreatePseudoConsole: {}",
                    error.message()
                )));
            }
        };
        // A failed confined launch must never widen the process authority.
        let (parts, grants, container) = match launch(&spec, console, job, true) {
            Ok(parts) => parts,
            Err(error) => {
                unsafe {
                    ClosePseudoConsole(console);
                    for handle in [input_read, input_write, output_read, output_write, job] {
                        let _ = CloseHandle(handle);
                    }
                }
                return Err(error);
            }
        };
        Ok(Pty {
            console,
            pty_input: input_read,
            pty_output: output_write,
            input: unsafe { std::fs::File::from_raw_handle(input_write.0 as RawHandle) },
            output: unsafe { std::fs::File::from_raw_handle(output_read.0 as RawHandle) },
            process: parts.process,
            job,
            pid: parts.pid,
            exit: None,
            confined: parts.confined,
            _grants: grants,
            _container: container,
        })
    }

    /// Whether the child was placed in an AppContainer.
    pub fn confined(&self) -> bool {
        self.confined
    }

    /// Process id of the direct child (its tree lives in the job object).
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Blocking read of the pseudoconsole output pipe. Returns `0` at end of
    /// stream: the pipe broke, or the child exited and the console host flushed
    /// its final bytes.
    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        Ok(pipe_read(&mut self.output, self.process, buf, None)?.unwrap_or(0))
    }

    /// Write raw bytes to the pseudoconsole input pipe.
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.input.write_all(bytes)
    }

    /// Resize the pseudoconsole window, observable by the child's console API.
    pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        unsafe { ResizePseudoConsole(self.console, size) }
            .map_err(|error| io::Error::other(error.message()))
    }

    /// Report the child's exit code once it has exited, without waiting.
    pub fn poll_exit(&mut self) -> io::Result<Option<i32>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        if unsafe { WaitForSingleObject(self.process, 0) }.0 != WAIT_OBJECT_0.0 {
            return Ok(None);
        }
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.process, &mut code) }
            .map_err(|error| io::Error::other(error.message()))?;
        self.exit = Some(code as i32);
        Ok(self.exit)
    }

    /// Kill the whole process tree. Idempotent; safe after the child has exited.
    pub fn kill(&mut self) {
        unsafe {
            let _ = TerminateJobObject(self.job, 1);
            let _ = TerminateProcess(self.process, 1);
        }
    }

    /// Duplicate the output read handle so a worker thread can block on it while
    /// the session keeps handling writes, resizes and exit polling.
    pub fn try_clone_reader(&self) -> io::Result<PtyReader> {
        let mut process = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.process,
                GetCurrentProcess(),
                &mut process,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )
        }
        .map_err(|error| io::Error::other(error.message()))?;
        match self.output.try_clone() {
            Ok(file) => Ok(PtyReader { file, process }),
            Err(error) => {
                unsafe {
                    let _ = CloseHandle(process);
                }
                Err(error)
            }
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.kill();
        // Drain what is already buffered so `ClosePseudoConsole` cannot block on
        // a full output pipe once the reader is gone. After the kill above the
        // child is gone, so each poll sees EOF quickly; the deadline keeps this
        // bounded even if the process handle never signals.
        let mut buffer = [0u8; 4096];
        for _ in 0..8 {
            match pipe_read(
                &mut self.output,
                self.process,
                &mut buffer,
                Some(Instant::now() + Duration::from_millis(100)),
            ) {
                Ok(Some(0)) | Ok(None) | Err(_) => break,
                Ok(Some(_)) => {}
            }
        }
        unsafe {
            ClosePseudoConsole(self.console);
            let _ = CloseHandle(self.pty_input);
            let _ = CloseHandle(self.pty_output);
            let _ = CloseHandle(self.process);
            let _ = CloseHandle(self.job);
        }
    }
}

/// An independent blocking reader for a [`Pty`]'s output pipe.
pub struct PtyReader {
    file: std::fs::File,
    process: HANDLE,
}
// See the note on `Pty`: handles are process-wide and this one is owned here.
unsafe impl Send for PtyReader {}

impl PtyReader {
    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        Ok(pipe_read(&mut self.file, self.process, buf, None)?.unwrap_or(0))
    }

    /// Read with a deadline. Returns `Ok(None)` when no output arrived and the
    /// child is still running, so a worker can check cancellation instead of
    /// blocking forever on an idle terminal.
    pub fn read_timeout(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<Option<usize>> {
        pipe_read(
            &mut self.file,
            self.process,
            buf,
            Some(Instant::now() + timeout),
        )
    }
}

impl Drop for PtyReader {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.process);
        }
    }
}

struct Parts {
    process: HANDLE,
    pid: u32,
    confined: bool,
}

fn create_pipe() -> Result<(HANDLE, HANDLE), WinError> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    unsafe { CreatePipe(&mut read, &mut write, None, 0) }.map_err(|_| last_error("CreatePipe"))?;
    Ok((read, write))
}

/// Start the child on a pseudoconsole, optionally inside a fresh AppContainer.
fn launch(
    spec: &Spec,
    console: HPCON,
    job: HANDLE,
    confined: bool,
) -> Result<(Parts, Grants, Option<Container>), WinError> {
    let mut container = None;
    let mut grants = Grants::default();
    let mut capability_values: Vec<PSID> = Vec::new();
    let mut attribute_values: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    let mut capabilities = SECURITY_CAPABILITIES::default();
    if confined {
        let profile = new_container()?;
        let sid = profile.sid;
        container = Some(profile);
        // A launch failure releases the profile and revokes its ACLs.
        (|| -> Result<(), WinError> {
            for dir in &spec.writable {
                grant_modify(dir, sid, &mut grants)?;
                grant_path_discovery(dir, sid, &mut grants);
            }
            grant_console_objects(&mut grants, sid)
        })()?;
        if spec.allow_network {
            for capability in ["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"] {
                if let Some(value) = capability_sid(capability) {
                    capability_values.push(value);
                }
            }
        }
        attribute_values.extend(capability_values.iter().map(|value| SID_AND_ATTRIBUTES {
            Sid: PSID(value.0),
            Attributes: 0x0000_0004,
        }));
        capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: attribute_values.as_mut_ptr(),
            CapabilityCount: attribute_values.len() as u32,
            Reserved: 0,
        };
    }
    let result = create_process(spec, console, job, confined, &mut capabilities);
    for value in capability_values {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(value.0)));
        }
    }
    // Keep ACLs and the AppContainer alive for the full interactive lifetime.
    result.map(|parts| (parts, grants, container))
}

fn create_process(
    spec: &Spec,
    console: HPCON,
    job: HANDLE,
    confined: bool,
    capabilities: &mut SECURITY_CAPABILITIES,
) -> Result<Parts, WinError> {
    let attribute_count = if confined { 2 } else { 1 };
    let mut attribute_size = 0usize;
    unsafe {
        let _ = InitializeProcThreadAttributeList(None, attribute_count, None, &mut attribute_size);
    }
    if attribute_size == 0 {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let mut attribute_buffer = vec![0u8; attribute_size];
    let attributes = LPPROC_THREAD_ATTRIBUTE_LIST(attribute_buffer.as_mut_ptr() as *mut c_void);
    if unsafe {
        InitializeProcThreadAttributeList(
            Some(attributes),
            attribute_count,
            None,
            &mut attribute_size,
        )
    }
    .is_err()
    {
        return Err(last_error("InitializeProcThreadAttributeList"));
    }
    let prepared = (|| -> Result<(), WinError> {
        unsafe {
            if confined {
                UpdateProcThreadAttribute(
                    attributes,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    Some(capabilities as *mut _ as *const c_void),
                    size_of::<SECURITY_CAPABILITIES>(),
                    None,
                    None,
                )
                .map_err(|_| last_error("UpdateProcThreadAttribute(capabilities)"))?;
            }
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(console.0 as *const c_void),
                size_of::<HPCON>(),
                None,
                None,
            )
            .map_err(|_| last_error("UpdateProcThreadAttribute(pseudoconsole)"))?;
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        unsafe {
            DeleteProcThreadAttributeList(attributes);
        }
        return Err(error);
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // Claim the standard handles and mark them all invalid. Leaving them null
    // while the flag is set lets the child inherit this process's own standard
    // handles, so it writes to our stdout (or a redirected log) instead of the
    // pseudoconsole: the console then only yields its initialisation sequence
    // and the child dies on the caller's EOF stdin.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    startup.lpAttributeList = attributes;

    let mut command: Vec<u16> = command_line(&spec.argv)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let environment = environment_block(&spec.temp);
    // cmd.exe rejects verbatim canonical paths as UNC current directories.
    let cwd: Vec<u16> = dunce::simplified(&spec.cwd)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut process_info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            Some(environment.as_ptr() as *const c_void),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    unsafe {
        DeleteProcThreadAttributeList(attributes);
    }
    if let Err(error) = created {
        return Err(WinError::Start(format!(
            "CreateProcessW: {}",
            error.message()
        )));
    }
    if unsafe { AssignProcessToJobObject(job, process_info.hProcess) }.is_err() {
        unsafe {
            let _ = TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
        }
        return Err(WinError::Start("AssignProcessToJobObject failed".into()));
    }
    if unsafe { ResumeThread(process_info.hThread) } == u32::MAX {
        unsafe {
            let _ = TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
        }
        return Err(WinError::Start("ResumeThread failed".into()));
    }
    unsafe {
        let _ = CloseHandle(process_info.hThread);
    }
    Ok(Parts {
        process: process_info.hProcess,
        pid: process_info.dwProcessId,
        confined,
    })
}
/// Poll the output pipe without an overlapped wait: return data as soon as it is
/// available, `Ok(Some(0))` at end of stream (the pipe broke or the child exited
/// and the console host flushed), and `Ok(None)` when `deadline` passes with no
/// output while the child is still running.
fn pipe_read(
    file: &mut std::fs::File,
    process: HANDLE,
    buf: &mut [u8],
    deadline: Option<Instant>,
) -> io::Result<Option<usize>> {
    let handle = HANDLE(file.as_raw_handle());
    let mut grace = 0;
    loop {
        let mut available = 0u32;
        match unsafe { PeekNamedPipe(handle, None, 0, None, Some(&mut available), None) } {
            Ok(()) => {
                if available > 0 {
                    let want = buf.len().min(available as usize);
                    return match file.read(&mut buf[..want]) {
                        Ok(size) => Ok(Some(size)),
                        Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE.0 as i32) => {
                            Ok(Some(0))
                        }
                        Err(error) => Err(error),
                    };
                }
            }
            Err(_) => return Ok(Some(0)),
        }
        if unsafe { WaitForSingleObject(process, 0) }.0 == WAIT_OBJECT_0.0 {
            if grace == 0 {
                grace += 1;
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            return Ok(Some(0));
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                return Ok(None);
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}
/// Build a NUL-terminated, case-insensitively sorted UTF-16 environment block
/// that inherits the current process environment but points the temp variables
/// at the granted scratch directory.
fn environment_block(temp: &std::path::Path) -> Vec<u16> {
    let mut variables: Vec<(String, String)> = std::env::vars().collect();
    for key in ["TMPDIR", "TMP", "TEMP"] {
        let value = temp.as_os_str().to_string_lossy().into_owned();
        match variables
            .iter_mut()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
        {
            Some(entry) => entry.1 = value,
            None => variables.push((key.into(), value)),
        }
    }
    variables.sort_by_key(|entry| entry.0.to_uppercase());
    let mut block = Vec::new();
    for (name, value) in variables {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}
