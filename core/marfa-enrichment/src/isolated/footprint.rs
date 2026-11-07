//! How much memory a running child holds, by the kernel's own count.

/// The child's private memory in bytes, or none when the system will not say.
#[cfg(target_os = "macos")]
pub(super) fn of(pid: libc::pid_t) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: the buffer is the size of the flavor asked for.
    let status =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
    // SAFETY: a zero status means the kernel filled the buffer, and every bit pattern
    // of its integers is valid.
    (status == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

/// The resident pages that no file backs, so the program's own code and the models
/// inside it do not count. That is what `phys_footprint` counts on macOS.
#[cfg(target_os = "linux")]
pub(super) fn of(pid: libc::pid_t) -> Option<u64> {
    let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    private_bytes(&statm, page_size())
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    // SAFETY: sysconf reads a constant of the system.
    u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096)
}

#[cfg(target_os = "linux")]
fn private_bytes(statm: &str, page: u64) -> Option<u64> {
    let mut fields = statm.split_ascii_whitespace().skip(1);
    let resident: u64 = fields.next()?.parse().ok()?;
    let shared: u64 = fields.next()?.parse().ok()?;
    Some(resident.saturating_sub(shared) * page)
}

#[cfg(test)]
mod tests {
    #[test]
    fn this_process_has_a_footprint() {
        let pid = i32::try_from(std::process::id()).unwrap();
        assert!(super::of(pid).is_some_and(|bytes| bytes > 0));
    }

    #[test]
    fn a_process_that_is_gone_has_none() {
        assert_eq!(super::of(i32::MAX), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn file_backed_pages_do_not_count() {
        assert_eq!(super::private_bytes("100 30 10 1 0 5 0", 4096), Some(81920));
        assert_eq!(super::private_bytes("100", 4096), None);
    }
}
