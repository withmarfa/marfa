use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub(crate) enum Unlanded {
    Failed(io::Error),
    /// The target is no longer what the caller decided to write over.
    Changed,
}

impl std::fmt::Display for Unlanded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unlanded::Failed(error) => error.fmt(f),
            Unlanded::Changed => f.write_str("it changed on the disk while it was being written"),
        }
    }
}

impl From<Unlanded> for io::Error {
    fn from(unlanded: Unlanded) -> io::Error {
        match unlanded {
            Unlanded::Failed(error) => error,
            Unlanded::Changed => io::Error::other(Unlanded::Changed.to_string()),
        }
    }
}

impl From<io::Error> for Unlanded {
    fn from(error: io::Error) -> Unlanded {
        Unlanded::Failed(error)
    }
}

/// Writes `bytes` over `target` as [`land`] does.
pub(crate) fn write(
    target: &Path,
    bytes: &[u8],
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    land(target, |file, _| file.write_all(bytes), still)
}

/// Fills a new file beside `target`, in a directory that must exist, syncs it
/// and renames it over, so a write that fails at any point leaves the old
/// file whole. `fill` may also set the
/// new file's permissions and attributes by its path, before it lands.
///
/// `still` is asked, just before the rename, whether the target's bytes, or
/// `None` where there is none, are still what the caller decided to write
/// over; where they are not, nothing lands. A save made after that question
/// is still lost: no filesystem renames on a condition.
pub(crate) fn land(
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let (mut file, beside) = beside(dir)?;
    let landed = (|| {
        // A file written anew keeps the permission the one it replaces had,
        // and one its owner made read-only is refused, as a write in place
        // would be, though a rename could replace it.
        if let Ok(metadata) = std::fs::metadata(target)
            && metadata.is_file()
        {
            if metadata.permissions().readonly() {
                return Err(Unlanded::Failed(io::Error::from(
                    io::ErrorKind::PermissionDenied,
                )));
            }
            std::fs::set_permissions(&beside, metadata.permissions())?;
            keep_attributes(target, &beside);
        }
        fill(&mut file, &beside)?;
        file.sync_all()?;
        drop(file);
        save_meanwhile(target);
        let found = match std::fs::read(target) {
            Ok(found) => Some(found),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(Unlanded::Failed(error)),
        };
        if !still(found.as_deref()) {
            return Err(Unlanded::Changed);
        }
        crash_if_asked(target);
        std::fs::rename(&beside, target)?;
        Ok(())
    })();
    if landed.is_err() {
        let _ = std::fs::remove_file(&beside);
        return landed;
    }
    // The rename is only durable once its directory is; a failure here
    // leaves the new file in place all the same.
    let _ = File::open(dir).and_then(|dir| dir.sync_all());
    Ok(())
}

/// Removes `target` where `still` says its bytes are what the caller decided
/// to remove. Answers whether it did; a target already gone answers `false`.
pub(crate) fn remove(target: &Path, still: impl FnOnce(&[u8]) -> bool) -> io::Result<bool> {
    save_meanwhile(target);
    let found = match std::fs::read(target) {
        Ok(found) => found,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !still(&found) {
        return Ok(false);
    }
    match std::fs::remove_file(target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// A crash between a write's record and its rename, where a fixture asks.
pub(crate) fn crash_if_asked(target: &Path) {
    if super::fault::named("crash-before-rename").is_some_and(|name| {
        target
            .file_name()
            .is_some_and(|file| file.to_string_lossy() == name)
    }) {
        eprintln!(
            "crashing before {} lands, as MARFA_TEST_FAULT asks",
            target.display()
        );
        std::process::abort();
    }
}

/// A Finder tag, say, which a file written anew would otherwise lose.
#[cfg(target_os = "macos")]
fn keep_attributes(from: &Path, to: &Path) {
    let Ok(names) = xattr::list(from) else {
        return;
    };
    for name in names {
        if let Ok(Some(value)) = xattr::get(from, &name) {
            let _ = xattr::set(to, &name, &value);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_attributes(_from: &Path, _to: &Path) {}

/// A file a write left beside its target, named for a process no longer
/// running: what a crash before the rename leaves.
pub(crate) fn left_behind(path: &Path) -> bool {
    let Some(pid) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(".marfa-"))
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .and_then(|rest| rest.split_once('-'))
        .filter(|(_, count)| count.parse::<u64>().is_ok())
        .and_then(|(pid, _)| pid.parse::<i32>().ok())
    else {
        return false;
    };
    pid != std::process::id().cast_signed() && !running(pid)
}

#[cfg(unix)]
fn running(pid: i32) -> bool {
    match rustix::process::Pid::from_raw(pid) {
        Some(pid) => !matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        ),
        None => true,
    }
}

#[cfg(not(unix))]
fn running(_pid: i32) -> bool {
    true
}

/// A person's save made between the folder's decision and its last look.
fn save_meanwhile(target: &Path) {
    if super::fault::named("save-before-last-look").is_some()
        && target
            .extension()
            .is_some_and(|extension| extension == "md")
        && target.is_file()
    {
        let _ = std::fs::OpenOptions::new()
            .append(true)
            .open(target)
            .and_then(|mut file| file.write_all(b"saved meanwhile\n"));
    }
}

/// Named so the built-in lists never take it (`*.tmp`), and in the target's
/// own directory, so the rename never crosses a volume.
fn beside(dir: &Path) -> io::Result<(File, PathBuf)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let path = dir.join(format!(
            ".marfa-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            // Left by a crashed process that had this id.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn a_write_that_fails_part_way_leaves_the_old_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        std::fs::write(&target, b"the person's whole text").unwrap();
        let failed = land(
            &target,
            |file, _| {
                file.write_all(b"half")?;
                Err(io::Error::other("the disk is full"))
            },
            |_| true,
        );
        assert!(matches!(failed, Err(Unlanded::Failed(_))));
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"the person's whole text",
            "a write that failed after it began left the file cut short, and the next scan sends what is left as an edit"
        );
        assert!(leftovers(dir.path()).is_empty());
        // The witness: the same write that does not fail lands.
        write(&target, b"new text", |_| true).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new text");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_target_changed_before_the_rename_is_left_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        std::fs::write(&target, b"as last written").unwrap();
        let changed = land(
            &target,
            |file, _| {
                // The person saves while the new file is written.
                std::fs::write(&target, b"the person's save")?;
                file.write_all(b"from the server")
            },
            |found| found == Some(b"as last written".as_slice()),
        );
        assert!(matches!(changed, Err(Unlanded::Changed)));
        assert_eq!(std::fs::read(&target).unwrap(), b"the person's save");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_written_anew_keeps_its_permission_and_gets_a_new_inode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("tool.sh");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        let before = std::fs::metadata(&target).unwrap().ino();
        write(&target, b"new", |_| true).unwrap();
        let after = std::fs::metadata(&target).unwrap();
        assert_ne!(after.ino(), before, "the file was written in place");
        assert_eq!(after.permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn a_file_left_by_a_process_no_longer_running_is_named_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let mut ended = std::process::Command::new("true").spawn().unwrap();
        let gone = ended.id();
        ended.wait().unwrap();
        let left = dir.path().join(format!(".marfa-{gone}-0.tmp"));
        assert!(left_behind(&left));
        // The witness: this process's own is not, nor a name it never writes.
        let own = dir
            .path()
            .join(format!(".marfa-{}-0.tmp", std::process::id()));
        assert!(!left_behind(&own));
        assert!(!left_behind(&dir.path().join(format!(".marfa-{gone}.tmp"))));
        assert!(!left_behind(&dir.path().join("notes.tmp")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_written_anew_keeps_its_other_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        std::fs::write(&target, b"old").unwrap();
        xattr::set(&target, "com.example.kept", b"yes").unwrap();
        write(&target, b"new", |_| true).unwrap();
        assert_eq!(
            xattr::get(&target, "com.example.kept").unwrap().as_deref(),
            Some(b"yes".as_slice())
        );
    }

    #[test]
    fn removes_only_what_is_still_the_callers() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        std::fs::write(&target, b"edited since").unwrap();
        assert!(!remove(&target, |found| found == b"as written").unwrap());
        assert!(target.exists());
        assert!(remove(&target, |found| found == b"edited since").unwrap());
        assert!(!target.exists());
        assert!(!remove(&target, |_| true).unwrap());
    }
}
