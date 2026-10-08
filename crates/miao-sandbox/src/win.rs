//! Windows AppContainer + job-object sandbox backend.
//!
//! Creates/reuses an AppContainer, grants Modify only on the work/allow dirs,
//! denies network unless allow_network, and runs the command inside it under a
//! job object so the whole tree dies with miao-run.

use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    EXPLICIT_ACCESS_W, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
};
use windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeleteAppContainerProfile};
use windows::Win32::Security::{
    FreeSid, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES,
    SID_AND_ATTRIBUTES,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTUPINFOEXW,
};

pub enum WinError {
    /// Container/ACL setup failed (e.g. no privileges) — caller falls back.
    Unavailable(String),
    /// Sandbox was applied but the command could not be started.
    Start(String),
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

/// Grant the given SID `Modify` on `path`, remembering the original DACL so it
/// can be restored on cleanup.
struct AclGrant {
    path: Vec<u16>,
    old_dacl: *mut ACL,
    old_sd: *mut c_void,
}

fn grant_modify(path: &Path, sid: PSID, grants: &mut Vec<AclGrant>) -> Result<(), WinError> {
    let mut wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();

    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut old_sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let status = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(wide_path.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_dacl),
            None,
            &mut old_sd,
        )
    };
    if status.0 != 0 {
        return Err(WinError::Unavailable(format!(
            "GetNamedSecurityInfoW failed: {status:?}"
        )));
    }

    let mut entry = EXPLICIT_ACCESS_W::default();
    entry.grfAccessPermissions =
        (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE).0;
    entry.grfAccessMode = SET_ACCESS;
    // File-provider APIs open/reopen descendants rather than only creating a
    // directory entry. The allowlist must apply to the whole selected tree.
    entry.grfInheritance = windows::Win32::Security::SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
    entry.Trustee.ptstrName = PWSTR(sid.0 as *mut u16);

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let rc = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl) };
    if rc.0 != 0 {
        unsafe {
            if !old_sd.0.is_null() {
                LocalFree(Some(HLOCAL(old_sd.0)));
            }
        }
        return Err(WinError::Unavailable(format!(
            "SetEntriesInAclW failed: {rc:?}"
        )));
    }

    let status = unsafe {
        SetNamedSecurityInfoW(
            PWSTR(wide_path.as_mut_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl as *const ACL),
            None,
        )
    };
    unsafe {
        if !new_dacl.is_null() {
            LocalFree(Some(HLOCAL(new_dacl as *mut c_void)));
        }
    }
    if status.0 != 0 {
        unsafe {
            if !old_sd.0.is_null() {
                LocalFree(Some(HLOCAL(old_sd.0)));
            }
        }
        return Err(WinError::Unavailable(format!(
            "SetNamedSecurityInfoW failed: {status:?}"
        )));
    }

    grants.push(AclGrant {
        path: wide_path,
        old_dacl,
        old_sd: old_sd.0,
    });
    Ok(())
}

fn restore_grants(grants: &[AclGrant]) {
    for grant in grants {
        let mut path = grant.path.clone();
        let _ = unsafe {
            SetNamedSecurityInfoW(
                PWSTR(path.as_mut_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(grant.old_dacl as *const ACL),
                None,
            )
        };
        if !grant.old_sd.is_null() {
            unsafe { LocalFree(Some(HLOCAL(grant.old_sd))) };
        }
    }
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
    let mut grants: Vec<AclGrant> = Vec::new();
    let result = (|| -> Result<(), WinError> {
        for dir in workdirs.iter().chain(allow_paths.iter()) {
            grant_modify(dir, sid, &mut grants)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        restore_grants(&grants);
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
            restore_grants(&grants);
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
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
    }
    let mut attr_buffer = vec![0u8; attr_size];
    let attr_list = windows::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST(
        attr_buffer.as_mut_ptr() as *mut c_void,
    );
    unsafe {
        InitializeProcThreadAttributeList(Some(attr_list), 1, None, &mut attr_size)
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

    let cmdline: Vec<u16> = command
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
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
            false,
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
    if create.is_err() {
        restore_grants(&grants);
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err(WinError::Start(
            windows::core::Error::from_win32().message().to_string(),
        ));
    }
    let job_assigned = unsafe { AssignProcessToJobObject(job, process_info.hProcess) };
    if job_assigned.is_err() {
        unsafe {
            let _ = TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(job);
        }
        restore_grants(&grants);
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
        restore_grants(&grants);
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

    restore_grants(&grants);
    for value in capability_sids {
        unsafe { LocalFree(Some(HLOCAL(value.0 as *mut c_void))) };
    }

    Ok(exit_code as i32)
}
