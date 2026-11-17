use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn stats_of(path: &Path) -> Option<libc::statvfs> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` is plain integers, for which all zeros is a valid value.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `statvfs` writes only into the struct it is given, and `path`
    // is a NUL-terminated string that outlives the call.
    let answered = unsafe { libc::statvfs(path.as_ptr(), &mut stats) };
    (answered == 0).then_some(stats)
}

pub fn free_bytes(path: &Path) -> Option<u64> {
    // The two fields are narrower than u64 on some platforms and not others.
    #[allow(clippy::useless_conversion)]
    stats_of(path).map(|stats| u64::from(stats.f_bavail) * u64::from(stats.f_frsize))
}

/// The size of the volume that holds `path`, whatever is free on it.
pub fn size_bytes(path: &Path) -> Option<u64> {
    #[allow(clippy::useless_conversion)]
    stats_of(path).map(|stats| u64::from(stats.f_blocks) * u64::from(stats.f_frsize))
}

/// What tells two paths' volumes apart or together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Facts {
    device: u64,
    free: u64,
}

fn facts_of(path: &Path) -> Option<Facts> {
    Some(Facts {
        device: std::fs::metadata(path).ok()?.dev(),
        free: free_bytes(path)?,
    })
}

/// Whether two volumes are not proven separate: one device, or one pool of free space under two.
fn shared_by(one: Option<Facts>, other: Option<Facts>) -> bool {
    match (one, other) {
        (Some(one), Some(other)) => one.device == other.device || one.free == other.free,
        _ => true,
    }
}

/// Whether `path` may share a volume with any of `others`; a pool read twice while it changes looks separate.
pub fn shares_with(path: &Path, others: &[&Path]) -> bool {
    let one = facts_of(path);
    others.iter().any(|other| shared_by(one, facts_of(other)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_volume_is_at_least_as_big_as_what_is_free_on_it() {
        let dir = tempfile::tempdir().unwrap();
        let size = size_bytes(dir.path()).unwrap();
        let free = free_bytes(dir.path()).unwrap();
        assert!(size > 0 && free <= size, "{free} of {size}");
    }

    #[test]
    fn two_folders_of_one_volume_share_it_and_a_path_that_cannot_be_read_is_taken_to_share() {
        let dir = tempfile::tempdir().unwrap();
        let (one, two) = (dir.path().join("one"), dir.path().join("two"));
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&two).unwrap();
        assert!(shares_with(&one, &[&two]));
        assert!(shares_with(&one, &[&dir.path().join("absent")]));
        assert!(shares_with(&dir.path().join("absent"), &[&two]));
    }
    #[test]
    fn volumes_are_separate_only_when_their_devices_and_their_free_space_differ() {
        let facts = |device, free| Some(Facts { device, free });
        // The witness for each way of sharing, so that the separate case below is not vacuous.
        assert!(shared_by(facts(1, 100), facts(1, 900)), "one device");
        assert!(
            shared_by(facts(1, 100), facts(2, 100)),
            "one pool of free space under two devices"
        );
        assert!(shared_by(facts(1, 100), None), "a volume that was not read");
        assert!(shared_by(None, facts(1, 100)));
        assert!(!shared_by(facts(1, 100), facts(2, 900)));
    }
}
