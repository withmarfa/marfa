//! The system calls a child may make on Linux, as a seccomp filter. Landlock has no
//! rule for `chmod`, `chown`, `utimes`, the extended attributes, UDP or a Unix socket
//! with a path, so it cannot alone stop a reader a file has taken over.
//!
//! The filter allows what the readers were measured to call and refuses the rest. A
//! list of what to deny would miss every call a newer kernel adds. Refusing with
//! `ENOSYS` rather than killing lets libc take the path it has for an older kernel,
//! and a refused call returns at once, so nothing waits on it.

use std::collections::BTreeMap;

use seccompiler::{
    BackendError, BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition,
    SeccompFilter, SeccompRule, TargetArch,
};

/// Calls a reader needs whatever it is reading. Reading and writing reach only the
/// descriptors a child holds: its three pipes and a model it opened.
const ALWAYS: &[libc::c_long] = &[
    libc::SYS_read,
    libc::SYS_readv,
    libc::SYS_pread64,
    libc::SYS_write,
    libc::SYS_writev,
    libc::SYS_lseek,
    libc::SYS_close,
    libc::SYS_fstat,
    libc::SYS_mmap,
    libc::SYS_mprotect,
    libc::SYS_munmap,
    libc::SYS_mremap,
    libc::SYS_madvise,
    libc::SYS_brk,
    libc::SYS_futex,
    libc::SYS_sched_yield,
    libc::SYS_clock_gettime,
    libc::SYS_clock_nanosleep,
    libc::SYS_nanosleep,
    libc::SYS_gettimeofday,
    libc::SYS_getpid,
    libc::SYS_gettid,
    libc::SYS_getppid,
    libc::SYS_getrandom,
    libc::SYS_getcwd,
    libc::SYS_rt_sigaction,
    libc::SYS_rt_sigprocmask,
    libc::SYS_rt_sigreturn,
    libc::SYS_sigaltstack,
    libc::SYS_exit,
    libc::SYS_exit_group,
];

/// A file opened to write, or made, is refused here as well as by Landlock, which
/// a kernel may not have.
const WRITING: u64 = (libc::O_WRONLY
    | libc::O_RDWR
    | libc::O_CREAT
    | libc::O_TRUNC
    | libc::O_APPEND
    | libc::O_TMPFILE) as u64;

fn dword(index: u8, op: SeccompCmpOp, value: u64) -> Result<SeccompCondition, BackendError> {
    SeccompCondition::new(index, SeccompCmpArgLen::Dword, op, value)
}

fn only_when(conditions: Vec<SeccompCondition>) -> Result<Vec<SeccompRule>, BackendError> {
    Ok(vec![SeccompRule::new(conditions)?])
}

fn rules(
    pid: libc::pid_t,
    opens_files: bool,
) -> Result<BTreeMap<i64, Vec<SeccompRule>>, BackendError> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> =
        ALWAYS.iter().map(|call| (*call, Vec::new())).collect();

    // abort() raises its signal through one of these, by the id of the main thread,
    // which is the process's. Nothing else in the system can be signalled.
    let itself = pid.cast_unsigned().into();
    for call in [libc::SYS_kill, libc::SYS_tkill, libc::SYS_tgkill] {
        rules.insert(call, only_when(vec![dword(0, SeccompCmpOp::Eq, itself)?])?);
    }
    // libc reads a limit through this call, which can also set one or read another
    // process's.
    rules.insert(
        libc::SYS_prlimit64,
        only_when(vec![
            dword(0, SeccompCmpOp::Eq, 0)?,
            SeccompCondition::new(2, SeccompCmpArgLen::Qword, SeccompCmpOp::Eq, 0)?,
        ])?,
    );
    rules.insert(
        libc::SYS_fcntl,
        only_when(vec![dword(1, SeccompCmpOp::Eq, libc::F_GETFD as u64)?])?,
    );
    if opens_files {
        rules.insert(
            libc::SYS_openat,
            only_when(vec![dword(2, SeccompCmpOp::MaskedEq(WRITING), 0)?])?,
        );
        #[cfg(target_arch = "x86_64")]
        rules.insert(
            libc::SYS_open,
            only_when(vec![dword(1, SeccompCmpOp::MaskedEq(WRITING), 0)?])?,
        );
    }
    Ok(rules)
}

/// The filter for this process, if this machine has a table of calls for it. `opens_files`
/// says whether the reading has a data folder to open: without one no call can open
/// anything at all.
pub(super) fn filter(opens_files: bool) -> Option<BpfProgram> {
    let arch = TargetArch::try_from(std::env::consts::ARCH).ok()?;
    // SAFETY: getpid takes nothing and cannot fail.
    let pid = unsafe { libc::getpid() };
    let filter = SeccompFilter::new(
        rules(pid, opens_files).ok()?,
        SeccompAction::Errno(libc::ENOSYS.cast_unsigned()),
        SeccompAction::Allow,
        arch,
    )
    .ok()?;
    filter.try_into().ok()
}

/// Whether the filter can hold a process here, tried on a process that can be spared.
/// Under Rosetta the kernel reports an arm64 caller to an x86_64 filter, which kills
/// any process on its next call, and a reader that dies on every file reads nothing.
///
/// The process must have one thread when this is called. A system that cannot start
/// another process leaves the question open, and the filter is applied.
pub(super) fn holds_here(filter: &BpfProgram) -> bool {
    // SAFETY: there is one thread, so the new process inherits no lock held elsewhere.
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        let code = i32::from(apply(filter).is_err());
        // SAFETY: ends the process, and is itself a call the filter has to allow.
        unsafe { libc::_exit(code) };
    }
    if pid < 0 {
        return true;
    }
    let mut status = 0;
    // SAFETY: `status` is a valid place for one int, and `pid` is this process's child.
    let waited = unsafe { libc::waitpid(pid, &raw mut status, 0) };
    waited == pid && libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
}

/// Applies the filter to every thread of this process at once.
pub(super) fn apply(filter: &BpfProgram) -> Result<(), seccompiler::Error> {
    seccompiler::apply_filter_all_threads(filter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_that_reaches_outside_the_child_is_allowed() {
        let allowed = rules(1, true).unwrap();
        for call in [
            libc::SYS_socket,
            libc::SYS_socketpair,
            libc::SYS_connect,
            libc::SYS_execve,
            libc::SYS_execveat,
            libc::SYS_clone,
            libc::SYS_clone3,
            libc::SYS_ptrace,
            libc::SYS_fchmod,
            libc::SYS_fchmodat,
            libc::SYS_fchown,
            libc::SYS_fchownat,
            libc::SYS_utimensat,
            libc::SYS_setxattr,
            libc::SYS_fsetxattr,
            libc::SYS_io_uring_setup,
            libc::SYS_bpf,
            libc::SYS_seccomp,
            libc::SYS_prctl,
            libc::SYS_setrlimit,
        ] {
            assert!(!allowed.contains_key(&call), "{call}");
        }
    }

    #[test]
    fn without_a_data_folder_no_file_can_be_opened() {
        assert!(rules(1, true).unwrap().contains_key(&libc::SYS_openat));
        assert!(!rules(1, false).unwrap().contains_key(&libc::SYS_openat));
    }

    #[test]
    fn a_filter_builds_for_this_machine() {
        assert!(filter(true).is_some());
        assert!(filter(false).is_some());
    }
}
