//! The open-file limit the connection caps must fit inside.

/// Descriptors kept for the database and its readers, blob files, outbound sockets and the
/// connections being turned away.
pub const RESERVE: u64 = 256;

/// `OPEN_MAX` in `<sys/syslimits.h>`, which macOS holds a soft limit to when its own per-process
/// figure cannot be read.
#[cfg(target_os = "macos")]
const OPEN_MAX: libc::rlim_t = 10_240;

#[cfg(target_os = "macos")]
fn most_per_process() -> Option<libc::rlim_t> {
    let mut most: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: the name is NUL-terminated and the buffer is the size given.
    let answered = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            (&raw mut most).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (answered == 0)
        .then(|| libc::rlim_t::try_from(most).ok())
        .flatten()
}

/// Raises the soft limit as far as the system allows. `None` when the limit is unbounded or
/// cannot be read.
pub fn raise() -> Option<u64> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: the call fills the struct it is given.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return None;
    }
    #[allow(unused_mut)]
    let mut wanted = vec![limit.rlim_max];
    // macOS refuses a soft limit above its per-process figure even when the hard limit is unbounded.
    #[cfg(target_os = "macos")]
    {
        if let Some(most) = most_per_process() {
            wanted.push(limit.rlim_max.min(most));
        }
        wanted.push(limit.rlim_max.min(OPEN_MAX));
    }
    for want in wanted {
        if want <= limit.rlim_cur {
            break;
        }
        let raised = libc::rlimit {
            rlim_cur: want,
            rlim_max: limit.rlim_max,
        };
        // SAFETY: the struct is fully set.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0 {
            limit.rlim_cur = want;
            break;
        }
    }
    (limit.rlim_cur != libc::RLIM_INFINITY).then_some(limit.rlim_cur)
}

/// The caps that fit inside `limit` beside the reserve, each at least one.
pub fn fit(total: usize, per_address: usize, limit: Option<u64>) -> (usize, usize) {
    let total = match limit {
        Some(limit) => {
            let room = usize::try_from(limit.saturating_sub(RESERVE)).unwrap_or(usize::MAX);
            total.min(room).max(1)
        }
        None => total,
    };
    (total, per_address.min(total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caps_stand_where_the_limit_has_room() {
        assert_eq!(fit(1_024, 256, None), (1_024, 256));
        assert_eq!(fit(1_024, 256, Some(1_280)), (1_024, 256));
        assert_eq!(fit(1_024, 256, Some(1_048_576)), (1_024, 256));
    }

    #[test]
    fn the_caps_shrink_to_what_the_limit_leaves() {
        assert_eq!(fit(1_024, 256, Some(1_024)), (768, 256));
        assert_eq!(fit(1_024, 256, Some(300)), (44, 44));
        assert_eq!(fit(1_024, 256, Some(100)), (1, 1));
    }

    #[test]
    fn the_soft_limit_rises_to_what_the_system_allows() {
        let mut before = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: as in `raise`.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut before) },
            0
        );
        let raised = raise();
        let mut after = before;
        // SAFETY: as in `raise`.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut after) },
            0
        );
        assert!(after.rlim_cur >= before.rlim_cur);
        assert_eq!(after.rlim_max, before.rlim_max);
        #[cfg(target_os = "macos")]
        assert!(after.rlim_cur >= before.rlim_max.min(OPEN_MAX));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(after.rlim_cur, before.rlim_max);
        assert_eq!(
            raised,
            (after.rlim_cur != libc::RLIM_INFINITY).then_some(after.rlim_cur)
        );
    }
}
