//! Windows AppContainer + job-object sandbox backend.
//!
//! Creates an invocation-owned AppContainer, grants Modify only on the work/allow dirs,
//! denies network unless allow_network, and runs the command inside it under a
//! job object so the whole tree dies with miao-run.

use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, LocalFree, DUPLICATE_SAME_ACCESS, HANDLE, HLOCAL,
    WIN32_ERROR,
};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW,
    SetNamedSecurityInfoW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS, REVOKE_ACCESS,
    SE_FILE_OBJECT, SE_WINDOW_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
};
use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile};
use windows::Win32::Security::{
    FreeSid, InitializeSecurityDescriptor, SetSecurityDescriptorDacl, ACL,
    DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES,
    SECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_TRAVERSE,
};
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
    GetCurrentThreadId, GetExitCodeProcess, InitializeProcThreadAttributeList, ReleaseMutex,
    ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use windows::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetThreadDesktop, DESKTOP_CREATEWINDOW, DESKTOP_READOBJECTS,
    DESKTOP_WRITEOBJECTS,
};

use windows::Win32::UI::WindowsAndMessaging::{
    WINSTA_ACCESSGLOBALATOMS, WINSTA_ENUMDESKTOPS, WINSTA_READATTRIBUTES,
};

pub enum WinError {
    /// Container/ACL setup failed (e.g. no privileges) — caller falls back.
    Unavailable(String),
    /// Sandbox was applied but the command could not be started.
    Start(String),
}

fn command_line(command: &[String]) -> String {
    let is_cmd = command
        .first()
        .and_then(|program| Path::new(program).file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cmd") || name.eq_ignore_ascii_case("cmd.exe")
        });
    if is_cmd {
        if let Some(index) = command
            .iter()
            .position(|arg| arg.eq_ignore_ascii_case("/c") || arg.eq_ignore_ascii_case("/k"))
        {
            if let Some(script) = command.get(index + 1) {
                // cmd parses its command payload itself, not as UCRT argv.
                // Backslash-escaping embedded quotes turns quoted paths into
                // invalid filenames. Keep script quotes inside one outer pair.
                let prefix = command[..=index]
                    .iter()
                    .map(|arg| quote_arg(arg))
                    .collect::<Vec<_>>()
                    .join(" ");
                let tail = command[index + 2..]
                    .iter()
                    .map(|arg| quote_arg(arg))
                    .collect::<Vec<_>>()
                    .join(" ");
                let payload = if tail.is_empty() {
                    script.clone()
                } else {
                    format!("{script} {tail}")
                };
                return format!("{prefix} \"{payload}\"");
            }
        }
    }
    command
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn last_error(context: &str) -> WinError {
    WinError::Unavailable(format!(
        "{context}: {}",
        windows::core::Error::from_win32().message()
    ))
}

enum AclTarget {
    Path(Vec<u16>),
    Discovery(Vec<u16>),
    Window(HANDLE),
}

// This older API is intentional for non-inherited ancestor discovery: unlike
// SetNamedSecurityInfo it does not recursively rewrite descendant ACLs.
#[link(name = "advapi32")]
extern "system" {
    #[link_name = "SetFileSecurityW"]
    fn set_file_security(path: *const u16, information: u32, descriptor: *const c_void) -> i32;
}
fn set_discovery_acl(path: &[u16], acl: *const ACL) -> WIN32_ERROR {
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    let pointer = PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast());
    unsafe {
        if InitializeSecurityDescriptor(pointer, 1).is_err()
            || SetSecurityDescriptorDacl(pointer, true, Some(acl), false).is_err()
        {
            return GetLastError();
        }
        if set_file_security(path.as_ptr(), DACL_SECURITY_INFORMATION.0, pointer.0) == 0 {
            return GetLastError();
        }
    }
    WIN32_ERROR(0)
}

struct AclGrant {
    target: AclTarget,
    sid: PSID,
    old_sd: *mut c_void,
}

#[derive(Default)]
struct StdioHandles(Vec<HANDLE>);
impl Drop for StdioHandles {
    fn drop(&mut self) {
        for handle in self.0.drain(..) {
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }
}
fn inherited_stdio() -> Result<StdioHandles, WinError> {
    use std::os::windows::io::AsRawHandle;
    let mut handles = StdioHandles::default();
    for kind in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let original = unsafe { GetStdHandle(kind) }
            .ok()
            .filter(|handle| !handle.is_invalid());
        let fallback = if original.is_none() {
            Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open("NUL")
                    .map_err(|error| WinError::Start(format!("open null stdio: {error}")))?,
            )
        } else {
            None
        };
        let original =
            original.unwrap_or_else(|| HANDLE(fallback.as_ref().unwrap().as_raw_handle()));
        let mut duplicate = HANDLE::default();
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                original,
                GetCurrentProcess(),
                &mut duplicate,
                0,
                true,
                DUPLICATE_SAME_ACCESS,
            )
            .map_err(|error| WinError::Start(format!("duplicate stdio: {}", error.message())))?;
        }
        handles.0.push(duplicate);
    }
    Ok(handles)
}

struct AclLock(HANDLE);
impl Drop for AclLock {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
fn acl_lock() -> Result<AclLock, WinError> {
    let name = wide("Local\\miao-sandbox-acl");
    let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
        .map_err(|_| last_error("CreateMutexW(ACL)"))?;
    let result = unsafe { WaitForSingleObject(handle, INFINITE) };
    if result.0 == 0 || result.0 == 0x80 {
        return Ok(AclLock(handle));
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    Err(last_error("WaitForSingleObject(ACL)"))
}

impl Drop for AclGrant {
    fn drop(&mut self) {
        // Other invocations can share the desktop/workspace. Revoke only our
        // unique SID from the current ACL, never overwrite another lease with
        // a stale snapshot. Lock read-modify-write across runner processes.
        let result = (|| -> Result<(), WinError> {
            let _lock = acl_lock()?;
            let mut descriptor = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
            let mut current: *mut ACL = std::ptr::null_mut();
            let status = unsafe {
                match &self.target {
                    AclTarget::Path(path) | AclTarget::Discovery(path) => GetNamedSecurityInfoW(
                        PCWSTR(path.as_ptr()),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        None,
                        None,
                        Some(&mut current),
                        None,
                        &mut descriptor,
                    ),
                    AclTarget::Window(handle) => GetSecurityInfo(
                        *handle,
                        SE_WINDOW_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        None,
                        None,
                        Some(&mut current),
                        None,
                        Some(&mut descriptor),
                    ),
                }
            };
            if status.0 != 0 {
                return Err(last_error("read ACL for revocation"));
            }
            let mut entry = EXPLICIT_ACCESS_W {
                grfAccessMode: REVOKE_ACCESS,
                ..Default::default()
            };
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
            entry.Trustee.ptstrName = PWSTR(self.sid.0 as *mut u16);
            let mut revoked: *mut ACL = std::ptr::null_mut();
            let merge = unsafe { SetEntriesInAclW(Some(&[entry]), Some(current), &mut revoked) };
            let status = if merge.0 == 0 {
                unsafe {
                    match &mut self.target {
                        AclTarget::Path(path) => SetNamedSecurityInfoW(
                            PWSTR(path.as_mut_ptr()),
                            SE_FILE_OBJECT,
                            DACL_SECURITY_INFORMATION,
                            None,
                            None,
                            Some(revoked as *const ACL),
                            None,
                        ),
                        AclTarget::Discovery(path) => {
                            set_discovery_acl(path, revoked as *const ACL)
                        }
                        AclTarget::Window(handle) => SetSecurityInfo(
                            *handle,
                            SE_WINDOW_OBJECT,
                            DACL_SECURITY_INFORMATION,
                            None,
                            None,
                            Some(revoked as *const ACL),
                            None,
                        ),
                    }
                }
            } else {
                merge
            };
            unsafe {
                if !revoked.is_null() {
                    LocalFree(Some(HLOCAL(revoked as *mut c_void)));
                }
                if !descriptor.0.is_null() {
                    LocalFree(Some(HLOCAL(descriptor.0)));
                }
            }
            if status.0 != 0 {
                return Err(last_error("revoke sandbox ACL"));
            }
            Ok(())
        })();
        if result.is_err() {
            eprintln!("miao-run: failed to revoke invocation ACL");
        }
        unsafe {
            if !self.old_sd.is_null() {
                LocalFree(Some(HLOCAL(self.old_sd)));
            }
        }
    }
}

#[derive(Default)]
struct Grants(Vec<AclGrant>);
impl Grants {
    fn push(&mut self, grant: AclGrant) {
        self.0.push(grant);
    }
    fn restore(&mut self) {
        // Restore descendants before parents so inherited entries disappear.
        while self.0.pop().is_some() {}
    }
}
impl Drop for Grants {
    fn drop(&mut self) {
        self.restore();
    }
}

fn grant_acl(
    target: AclTarget,
    sid: PSID,
    access: u32,
    inheritance: windows::Win32::Security::ACE_FLAGS,
    grants: &mut Grants,
) -> Result<(), WinError> {
    let _lock = acl_lock()?;
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut old_sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let status = unsafe {
        match &target {
            AclTarget::Path(path) | AclTarget::Discovery(path) => GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_dacl),
                None,
                &mut old_sd,
            ),
            AclTarget::Window(handle) => GetSecurityInfo(
                *handle,
                SE_WINDOW_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut old_dacl),
                None,
                Some(&mut old_sd),
            ),
        }
    };
    if status.0 != 0 {
        return Err(WinError::Unavailable(format!(
            "read sandbox ACL failed: {status:?}"
        )));
    }
    let mut grant = AclGrant {
        target,
        sid,
        old_sd: old_sd.0,
    };
    let mut entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: access,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: inheritance,
        ..Default::default()
    };
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
    entry.Trustee.ptstrName = PWSTR(sid.0 as *mut u16);
    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl) };
    if status.0 != 0 {
        return Err(WinError::Unavailable(format!(
            "SetEntriesInAclW failed: {status:?}"
        )));
    }
    let status = unsafe {
        match &mut grant.target {
            AclTarget::Path(path) => SetNamedSecurityInfoW(
                PWSTR(path.as_mut_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new_dacl as *const ACL),
                None,
            ),
            AclTarget::Discovery(path) => set_discovery_acl(path, new_dacl as *const ACL),
            AclTarget::Window(handle) => SetSecurityInfo(
                *handle,
                SE_WINDOW_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(new_dacl as *const ACL),
                None,
            ),
        }
    };
    unsafe {
        if !new_dacl.is_null() {
            LocalFree(Some(HLOCAL(new_dacl as *mut c_void)));
        }
    }
    if status.0 != 0 {
        return Err(WinError::Unavailable(format!(
            "set sandbox ACL failed: {status:?}"
        )));
    }
    grants.push(grant);
    Ok(())
}

fn grant_modify(path: &Path, sid: PSID, grants: &mut Grants) -> Result<(), WinError> {
    grant_acl(
        AclTarget::Path(
            path.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect(),
        ),
        sid,
        (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE).0,
        windows::Win32::Security::SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        grants,
    )
}

fn grant_path_discovery(path: &Path, sid: PSID, grants: &mut Grants) {
    // GetLongPathNameW (used by managed shells for 8.3 aliases) must list/read
    // attributes on ancestors. These grants are directory-only, not inherited:
    // they permit canonicalization without sibling file-content or write access.
    // Protected system ancestors can already be readable and need no new ACE;
    // setup may not have WRITE_DAC there, so an optional grant is best-effort.
    for parent in path
        .ancestors()
        .skip(1)
        .filter(|p| !p.as_os_str().is_empty())
    {
        let _ = grant_acl(
            AclTarget::Discovery(
                parent
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect(),
            ),
            sid,
            (FILE_GENERIC_READ | FILE_TRAVERSE).0,
            windows::Win32::Security::NO_INHERITANCE,
            grants,
        );
    }
}

fn grant_console_objects(grants: &mut Grants, sid: PSID) -> Result<(), WinError> {
    // Managed console runtimes load user32. An SSH/service desktop may exclude
    // AppContainer SIDs, producing STATUS_DLL_INIT_FAILED before main runs.
    // Grant this invocation only the initialization rights, not clipboard,
    // hook, or journaling permissions and not global package-group access.
    let station =
        unsafe { GetProcessWindowStation() }.map_err(|_| last_error("GetProcessWindowStation"))?;
    grant_acl(
        AclTarget::Window(HANDLE(station.0)),
        sid,
        (WINSTA_READATTRIBUTES | WINSTA_ENUMDESKTOPS | WINSTA_ACCESSGLOBALATOMS) as u32,
        windows::Win32::Security::NO_INHERITANCE,
        grants,
    )?;
    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) }
        .map_err(|_| last_error("GetThreadDesktop"))?;
    grant_acl(
        AclTarget::Window(HANDLE(desktop.0)),
        sid,
        DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_CREATEWINDOW.0,
        windows::Win32::Security::NO_INHERITANCE,
        grants,
    )
}

fn capability_sid(name: &str) -> Option<PSID> {
    let mut wide = wide(name);
    let mut sid = PSID(std::ptr::null_mut());
    unsafe { ConvertStringSidToSidW(PCWSTR(wide.as_mut_ptr()), &mut sid).ok() }.map(|_| sid)
}

fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
            }
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

pub fn run(
    workdirs: &[std::path::PathBuf],
    allow_paths: &[std::path::PathBuf],
    allow_network: bool,
    command: &[String],
) -> Result<i32, WinError> {
    // A process killed before cleanup can leave granted ACLs behind. Never
    // reuse its SID: otherwise another invocation could access its old paths.
    let name = wide(&format!(
        "miao.sandbox.{}.{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    let sid = unsafe {
        CreateAppContainerProfile(
            PCWSTR(name.as_ptr()),
            PCWSTR(name.as_ptr()),
            PCWSTR(name.as_ptr()),
            None,
        )
    }
    .map_err(|_| last_error("CreateAppContainerProfile"))?;
    // The profile and local SID are invocation-owned. Drop runs on all normal
    // returns (including setup errors); forced process death cannot run Drop.
    struct Container {
        name: Vec<u16>,
        sid: PSID,
    }
    impl Drop for Container {
        fn drop(&mut self) {
            unsafe {
                let _ = DeleteAppContainerProfile(PCWSTR(self.name.as_ptr()));
                FreeSid(self.sid);
            }
        }
    }
    let _container = Container { name, sid };

    // 2. Write allowlist: grant Modify on workdirs + allow_paths.
    let mut grants = Grants::default();
    let result = (|| -> Result<(), WinError> {
        for dir in workdirs.iter().chain(allow_paths.iter()) {
            grant_modify(dir, sid, &mut grants)?;
            grant_path_discovery(dir, sid, &mut grants);
        }
        grant_console_objects(&mut grants, sid)
    })();
    if let Err(error) = result {
        grants.restore();
        return Err(error);
    }

    // 3. Capabilities: none (no network) unless --allow-network.
    let mut capability_sids: Vec<PSID> = Vec::new();
    if allow_network {
        for cap in ["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"] {
            if let Some(value) = capability_sid(cap) {
                capability_sids.push(value);
            }
        }
    }
    // SE_GROUP_ENABLED (0x4): the capability must be enabled in the token.
    let mut attributes: Vec<SID_AND_ATTRIBUTES> = capability_sids
        .iter()
        .map(|value| SID_AND_ATTRIBUTES {
            Sid: PSID(value.0),
            Attributes: 0x0000_0004,
        })
        .collect();
    let mut security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: attributes.as_mut_ptr(),
        CapabilityCount: attributes.len() as u32,
        Reserved: 0,
    };

    // 4. Job object: tree dies when this process (or the handle) closes.
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) };
    let job = match job {
        Ok(handle) => handle,
        Err(_) => {
            grants.restore();
            return Err(last_error("CreateJobObjectW"));
        }
    };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|_| last_error("SetInformationJobObject"))?
    };

    // 5. Build process + attribute list with the AppContainer capabilities.
    let mut attr_size: usize = 0;
    unsafe {
        let _ = InitializeProcThreadAttributeList(None, 2, None, &mut attr_size);
    }
    let mut attr_buffer = vec![0u8; attr_size];
    let attr_list = windows::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST(
        attr_buffer.as_mut_ptr() as *mut c_void,
    );
    unsafe {
        InitializeProcThreadAttributeList(Some(attr_list), 2, None, &mut attr_size)
            .map_err(|_| last_error("InitializeProcThreadAttributeList"))?;
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&mut security_capabilities as *mut _ as *const c_void),
            size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(|_| last_error("UpdateProcThreadAttribute"))?;
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attr_list;
    // Console defaults do not carry a redirected stdio transport reliably.
    // Preserve the runner's pipes so managed shells initialize correctly and
    // callers receive the command's output instead of an empty result.
    startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    // Hosts such as Bun make their own standard handles non-inheritable.
    // HANDLE_LIST requires inheritable handles: duplicate them rather than
    // mutating the host's originals, and keep only the copies alive for spawn.
    let stdio = inherited_stdio()?;
    startup.StartupInfo.hStdInput = stdio.0[0];
    startup.StartupInfo.hStdOutput = stdio.0[1];
    startup.StartupInfo.hStdError = stdio.0[2];

    // Inherit only stdio, never unrelated handles owned by the runner process.
    let handles = [
        startup.StartupInfo.hStdInput,
        startup.StartupInfo.hStdOutput,
        startup.StartupInfo.hStdError,
    ];
    unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_ptr() as *const c_void),
            std::mem::size_of_val(&handles),
            None,
            None,
        )
        .map_err(|_| last_error("UpdateProcThreadAttribute(handles)"))?;
    }

    let cmdline: Vec<u16> = command_line(command)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut cmdline = cmdline;

    let cwd = workdirs.first().map(|dir| {
        dir.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    });

    let mut process_info = PROCESS_INFORMATION::default();
    let cwd_ptr = cwd
        .as_ref()
        .map(|value| PCWSTR(value.as_ptr()))
        .unwrap_or(PCWSTR::null());
    let create = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            true,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            None,
            cwd_ptr,
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    unsafe {
        DeleteProcThreadAttributeList(attr_list);
    }
    if let Err(error) = create {
        grants.restore();
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err(WinError::Start(format!(
            "CreateProcessW: {}",
            error.message()
        )));
    }
    let job_assigned = unsafe { AssignProcessToJobObject(job, process_info.hProcess) };
    if job_assigned.is_err() {
        unsafe {
            let _ = TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(job);
        }
        grants.restore();
        return Err(WinError::Start("AssignProcessToJobObject failed".into()));
    }

    // No child instructions run before tree containment is installed.
    if unsafe { ResumeThread(process_info.hThread) } == u32::MAX {
        unsafe {
            let _ = TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(job);
        }
        grants.restore();
        return Err(WinError::Start("ResumeThread failed".into()));
    }

    // 6. Wait for the child, then clean everything up.
    unsafe {
        WaitForSingleObject(process_info.hProcess, INFINITE);
    }
    let mut exit_code: u32 = 1;
    unsafe {
        let _ = GetExitCodeProcess(process_info.hProcess, &mut exit_code);
        let _ = CloseHandle(process_info.hProcess);
        let _ = CloseHandle(process_info.hThread);
        let _ = CloseHandle(job);
    }

    grants.restore();
    for value in capability_sids {
        unsafe { LocalFree(Some(HLOCAL(value.0 as *mut c_void))) };
    }

    Ok(exit_code as i32)
}
