//! The process's own CPU time and memory, as the operating system keeps them. Each reader
//! answers `None` where the system will not say, and on a platform with no reader.

use std::time::Duration;

/// CPU time the process has used since it started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cpu {
    pub user: Duration,
    pub system: Duration,
}

impl Cpu {
    pub fn total(self) -> Duration {
        self.user + self.system
    }
}

#[cfg(unix)]
fn usage() -> Option<libc::rusage> {
    let mut found = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: the buffer is a whole `rusage`, which the call fills when it answers 0.
    let answered = unsafe { libc::getrusage(libc::RUSAGE_SELF, found.as_mut_ptr()) };
    // SAFETY: filled by the call above, and any bits are valid integers.
    (answered == 0).then(|| unsafe { found.assume_init() })
}

#[cfg(unix)]
fn elapsed(time: libc::timeval) -> Duration {
    let seconds = u64::try_from(time.tv_sec).unwrap_or(0);
    let micros = u32::try_from(time.tv_usec).unwrap_or(0);
    Duration::new(seconds, micros.saturating_mul(1000))
}

#[cfg(unix)]
pub fn cpu() -> Option<Cpu> {
    let used = usage()?;
    Some(Cpu {
        user: elapsed(used.ru_utime),
        system: elapsed(used.ru_stime),
    })
}

#[cfg(not(unix))]
pub fn cpu() -> Option<Cpu> {
    None
}

/// The most resident memory the process has held, in bytes.
#[cfg(unix)]
pub fn peak_resident_bytes() -> Option<u64> {
    // The peak is bytes on macOS and kilobytes elsewhere.
    let unit: u64 = if cfg!(target_os = "macos") { 1 } else { 1024 };
    u64::try_from(usage()?.ru_maxrss)
        .ok()
        .map(|peak| peak.saturating_mul(unit))
}

#[cfg(not(unix))]
pub fn peak_resident_bytes() -> Option<u64> {
    None
}

/// The memory the process holds now, in bytes.
#[cfg(target_os = "macos")]
pub fn resident_bytes() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = i32::try_from(size_of::<libc::proc_taskinfo>()).ok()?;
    let pid = i32::try_from(std::process::id()).ok()?;
    // SAFETY: the buffer is the size of the flavor asked for.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    // SAFETY: the kernel filled the whole buffer, and any bits are valid integers.
    (written == size).then(|| unsafe { info.assume_init() }.pti_resident_size)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn resident_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: a plain query with no pointers.
    let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    Some(pages * page)
}

#[cfg(not(unix))]
pub fn resident_bytes() -> Option<u64> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_process_that_has_run_has_used_cpu_and_holds_memory() {
        // Spend a little CPU so the reading cannot be zero.
        let mut sum = 0_u64;
        for n in 0..5_000_000_u64 {
            sum = sum.wrapping_add(std::hint::black_box(n));
        }
        std::hint::black_box(sum);
        assert!(cpu().unwrap().total() > Duration::ZERO);
        let now = resident_bytes().unwrap();
        let peak = peak_resident_bytes().unwrap();
        assert!(now > 1_000_000, "{now}");
        assert!(peak >= now / 2, "{peak} against {now}");
    }
}
