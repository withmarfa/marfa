//! What a child does to itself. Each limit is only ever lowered, and hard and soft
//! together, so code a file has taken over cannot raise it again.

use std::path::Path;
use std::time::Duration;

use crate::Sandbox;

/// The descriptors a child may hold: three standard ones, the sandbox's while it is
/// set up, and one model file at a time.
const MOST_DESCRIPTORS: u64 = 16;

/// Address space a child may hold past `max_memory_bytes`, on top of the program's
/// own mapped size. The footprint the parent watches is the limit a reading meets;
/// this is the kernel's backstop behind it, so it must never bind first on a page
/// that fits the limit.
#[cfg(target_os = "linux")]
const ADDRESS_SPACE_HEADROOM: u64 = 256 * 1024 * 1024;

/// Sets a limit to at most `soft` and `hard`. A limit that the process already holds
/// lower stays, because raising a hard limit needs a privilege a child should not
/// have. A test runner's own caps meet this.
fn lower(resource: LimitKind, soft: u64, hard: u64) {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid buffer, and `resource` is a limit this system has.
    if unsafe { libc::getrlimit(resource, &raw mut limit) } != 0 {
        return;
    }
    limit.rlim_max = limit.rlim_max.min(hard as libc::rlim_t);
    limit.rlim_cur = limit.rlim_max.min(soft as libc::rlim_t);
    // SAFETY: as above.
    unsafe { libc::setrlimit(resource, &raw const limit) };
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub(super) type LimitKind = libc::__rlimit_resource_t;
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
pub(super) type LimitKind = libc::c_int;

/// Everything that needs no number from the parent: no core file, no file written, no
/// descriptor of the parent's kept.
pub(super) fn let_go_of_what_was_inherited() {
    no_crash_reports();
    close_descriptors_above_stderr();
    lower(libc::RLIMIT_CORE, 0, 0);
    lower(libc::RLIMIT_FSIZE, 0, 0);
    lower(libc::RLIMIT_NOFILE, MOST_DESCRIPTORS, MOST_DESCRIPTORS);
    #[cfg(target_os = "linux")]
    // SAFETY: this prctl takes plain integers and changes only this process.
    unsafe {
        libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
    };
}

/// Processor time and, where the kernel enforces it, address space.
pub(super) fn take_limits(time_limit: Duration, max_memory: u64) {
    // SIGXCPU at the soft limit, which the parent reads as out of time. The hard limit
    // a second later is for code that catches it. Rounded up, because the limit is in
    // whole seconds and a reader that only ever uses the processor must meet the
    // parent's deadline first.
    let seconds = time_limit.as_secs() + 2;
    lower(libc::RLIMIT_CPU, seconds, seconds + 1);
    #[cfg(target_os = "linux")]
    {
        let space = max_memory
            .saturating_add(ADDRESS_SPACE_HEADROOM)
            .saturating_add(program_size());
        lower(libc::RLIMIT_AS, space, space);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = max_memory;
}

/// The program's size counts against its address space, and carries the OCR models.
#[cfg(target_os = "linux")]
fn program_size() -> u64 {
    std::fs::metadata("/proc/self/exe").map_or(256 * 1024 * 1024, |file| file.len())
}

#[cfg(target_os = "linux")]
fn close_descriptors_above_stderr() {
    // SAFETY: closes descriptors only, and nothing in this process holds one yet.
    let closed = unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) };
    if closed != 0 {
        close_listed_descriptors("/proc/self/fd");
    }
}

#[cfg(not(target_os = "linux"))]
fn close_descriptors_above_stderr() {
    close_listed_descriptors("/dev/fd");
}

/// A listing costs one call per open descriptor where a count through the limit could
/// cost a million. Without one, the loop is all that is left, kept to a sane length.
fn close_listed_descriptors(folder: &str) {
    let close = |fd: libc::c_int| {
        // SAFETY: nothing in this process holds a descriptor above 2 at this point.
        unsafe { libc::close(fd) };
    };
    let listed: Option<Vec<libc::c_int>> = std::fs::read_dir(folder).ok().map(|entries| {
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
            .collect()
    });
    match listed {
        Some(open) => open.into_iter().filter(|fd| *fd > 2).for_each(close),
        None => (3..65536).for_each(close),
    }
}

/// A crash here is a bad file doing what was expected, so on macOS it does not go to
/// the crash reporter, which would leave a report on the owner's disk for each one.
#[cfg(target_os = "macos")]
fn no_crash_reports() {
    /// `EXC_MASK_ALL`.
    const ALL_EXCEPTIONS: u32 = 0x1bfe;
    /// `EXCEPTION_DEFAULT`.
    const DEFAULT_BEHAVIOR: libc::c_int = 1;
    /// `THREAD_STATE_NONE`, which differs by architecture.
    #[cfg(target_arch = "aarch64")]
    const NO_THREAD_STATE: libc::c_int = 5;
    #[cfg(target_arch = "x86_64")]
    const NO_THREAD_STATE: libc::c_int = 13;

    unsafe extern "C" {
        static mach_task_self_: libc::c_uint;
        fn task_set_exception_ports(
            task: libc::c_uint,
            exception_mask: u32,
            new_port: libc::c_uint,
            behavior: libc::c_int,
            new_flavor: libc::c_int,
        ) -> libc::c_int;
    }
    // SAFETY: a null port removes this task's handlers, and touches nothing else.
    unsafe {
        task_set_exception_ports(
            mach_task_self_,
            ALL_EXCEPTIONS,
            0,
            DEFAULT_BEHAVIOR,
            NO_THREAD_STATE,
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn no_crash_reports() {}

/// Stops this user starting any more processes or threads, which a file that takes
/// over a reader might want to outlive it. Limits nothing for root, and macOS's
/// sandbox stops `fork` by itself.
pub(super) fn start_no_more_processes() {
    #[cfg(target_os = "linux")]
    lower(libc::RLIMIT_NPROC, 0, 0);
}

/// Allows only reading `data_dir`. Linux has this through Landlock.
#[cfg(target_os = "linux")]
pub(super) fn deny_files_and_network(data_dir: Option<&Path>) -> Sandbox {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, PathBeneath, PathFd, Ruleset, RulesetAttr,
        RulesetCreatedAttr, RulesetStatus, Scope,
    };

    // ABI 6 holds everything asked for here. A kernel that has less enforces what it
    // can, and the status says so.
    let abi = ABI::V6;
    let confine = || -> Result<RulesetStatus, landlock::RulesetError> {
        let mut ruleset = Ruleset::default()
            .handle_access(AccessFs::from_all(abi))?
            .handle_access(AccessNet::from_all(abi))?
            .scope(Scope::from_all(abi))?
            .create()?;
        if let Some(dir) = data_dir
            && let Ok(dir) = PathFd::new(dir)
        {
            ruleset = ruleset.add_rule(PathBeneath::new(dir, AccessFs::from_read(abi)))?;
        }
        Ok(ruleset.restrict_self()?.ruleset)
    };
    match confine() {
        Ok(RulesetStatus::FullyEnforced) => Sandbox::Full,
        Ok(RulesetStatus::PartiallyEnforced) => Sandbox::Partial,
        Ok(RulesetStatus::NotEnforced) | Err(_) => Sandbox::Off,
    }
}

/// Allows only reading `data_dir`. `sandbox_init` is marked deprecated and has stayed
/// the only public way into the system's sandbox.
#[cfg(target_os = "macos")]
pub(super) fn deny_files_and_network(data_dir: Option<&Path>) -> Sandbox {
    use std::ffi::{CString, c_char};

    unsafe extern "C" {
        fn sandbox_init(profile: *const c_char, flags: u64, error: *mut *mut c_char) -> i32;
        fn sandbox_free_error(error: *mut c_char);
    }
    let Ok(profile) = CString::new(profile(data_dir)) else {
        return Sandbox::Off;
    };
    let mut error = std::ptr::null_mut();
    // SAFETY: `profile` is a NUL-terminated string for the length of the call, and
    // `error` is set only to a string freed below.
    let status = unsafe { sandbox_init(profile.as_ptr(), 0, &raw mut error) };
    if !error.is_null() {
        // SAFETY: `error` came from sandbox_init.
        unsafe { sandbox_free_error(error) };
    }
    if status == 0 {
        Sandbox::Full
    } else {
        Sandbox::Off
    }
}

/// A profile in the sandbox's Scheme dialect. No process, no network, no file but the
/// data folder, whose path is a string literal here, so its quotes and backslashes are
/// what could break out of it.
#[cfg(any(target_os = "macos", test))]
fn profile(data_dir: Option<&Path>) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    let mut profile = b"(version 1)(deny default (with no-report))".to_vec();
    if let Some(dir) = data_dir {
        profile.extend_from_slice(b"(allow file-read* (subpath \"");
        for &byte in dir.as_os_str().as_bytes() {
            if matches!(byte, b'"' | b'\\') {
                profile.push(b'\\');
            }
            profile.push(byte);
        }
        profile.extend_from_slice(b"\"))");
    }
    profile
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn a_data_folder_cannot_break_out_of_the_profile() {
        let profile = super::profile(Some(Path::new(r#"/a"b\c"#)));
        assert!(
            String::from_utf8(profile)
                .unwrap()
                .ends_with(r#"(subpath "/a\"b\\c"))"#)
        );
    }

    #[test]
    fn with_no_data_folder_nothing_is_allowed() {
        let profile = String::from_utf8(super::profile(None)).unwrap();
        assert!(!profile.contains("allow"));
    }
}
