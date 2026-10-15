use crate::directory::Directory;
use crate::directory::{Mode, OFlags};
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
#[cfg(test)]
pub(crate) fn write(
    target: &Path,
    bytes: &[u8],
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let dir = Directory::open(parent)?;
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::other("missing target name"))?;
    land_at(
        &dir,
        Path::new(name),
        |file, _| file.write_all(bytes),
        still,
    )
}

/// Fills a new file beside `target`, in a directory that must exist, syncs it
/// and renames it over, so a write that fails at any point leaves the old
/// file whole. `fill` may also set the
/// new file's permissions and attributes through its descriptor, before it lands.
///
/// `still` is asked, just before the rename, whether the target's bytes, or
/// `None` where there is none, are still what the caller decided to write
/// over; where they are not, nothing lands. An absent target must stay absent
/// through the atomic rename. Replacing an existing file still cannot be
/// conditional on its bytes after that last check.
pub(crate) fn land_at(
    dir: &Directory,
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    let (mut file, beside) = beside(dir)?;
    let landed = (|| {
        // A file written anew keeps the permission the one it replaces had,
        // and one its owner made read-only is refused, as a write in place
        // would be, though a rename could replace it.
        if let Ok(source) = dir.open_file(target, OFlags::RDONLY, Mode::empty())
            && let Ok(metadata) = source.metadata()
        {
            if metadata.permissions().readonly() {
                return Err(Unlanded::Failed(io::Error::from(
                    io::ErrorKind::PermissionDenied,
                )));
            }
            file.set_permissions(metadata.permissions())?;
            keep_attributes(&source, &file);
        }
        fill(&mut file, &beside)?;
        if crate::fault::named("sync-failure").is_some_and(|name| {
            target
                .file_name()
                .is_some_and(|file| file.to_string_lossy() == name)
        }) {
            return Err(Unlanded::Failed(io::Error::other(
                "sync refused by fixture",
            )));
        }
        file.sync_all()?;
        drop(file);
        save_meanwhile(dir, target);
        let found = match dir.read(target) {
            Ok(found) => Some(found),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(Unlanded::Failed(error)),
        };
        if !still(found.as_deref()) {
            return Err(Unlanded::Changed);
        }
        crash_if_asked(target);
        crash_if_named(target, "crash-before-copy-publish");
        appear_at(dir, target, "create-before-rename")?;
        if found.is_none() {
            rename_new_at(dir, &beside, dir, target).map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    Unlanded::Changed
                } else {
                    Unlanded::Failed(error)
                }
            })?;
        } else {
            dir.rename(&beside, dir, target, false)?;
        }
        Ok(())
    })();
    if landed.is_err() {
        let _ = dir.unlink(&beside);
        return landed;
    }
    // The rename is only durable once its directory is; a failure here
    // leaves the new file in place all the same.
    let _ = dir.sync();
    Ok(())
}

/// Move only into an absent directory entry, including refusing a dangling
/// symlink. Unsupported kernels or filesystems must not fall back to replacing
/// a destination after a separate existence check.
pub(crate) fn rename_new_at(
    from_dir: &Directory,
    from: &Path,
    to_dir: &Directory,
    to: &Path,
) -> io::Result<()> {
    if crate::fault::named("rename-new-unsupported").is_some_and(|name| {
        to.file_name()
            .is_some_and(|file| file.to_string_lossy() == name)
    }) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no-replace publication unavailable in fixture",
        ));
    }
    from_dir.rename(from, to_dir, to, true)
}

/// Removes `target` where `still` says its bytes are what the caller decided
/// to remove. Answers whether it did; a target already gone answers `false`.
pub(crate) fn remove_at(
    dir: &Directory,
    target: &Path,
    still: impl FnOnce(&[u8]) -> bool,
) -> io::Result<bool> {
    remove_checked_at(dir, target, still).map_err(|error| match error {
        RemoveError::Read(error) | RemoveError::Remove(error) => error,
    })
}

pub(crate) enum RemoveError {
    Read(io::Error),
    Remove(io::Error),
}

pub(crate) fn remove_checked_at(
    dir: &Directory,
    target: &Path,
    still: impl FnOnce(&[u8]) -> bool,
) -> Result<bool, RemoveError> {
    save_meanwhile(dir, target);
    let found = match dir.read(target) {
        Ok(found) => found,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(RemoveError::Read(error)),
    };
    if !still(&found) {
        return Ok(false);
    }
    match dir.unlink(target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(RemoveError::Remove(error)),
    }
}

/// A crash between a write's record and its rename, where a fixture asks.
pub(crate) fn crash_if_asked(target: &Path) {
    crash_if_named(target, "crash-before-rename");
}

pub(crate) fn crash_if_named(target: &Path, fault: &str) {
    if crate::fault::named(fault).is_some_and(|name| {
        target
            .file_name()
            .is_some_and(|file| file.to_string_lossy() == name)
    }) {
        eprintln!("crashing at {} as MARFA_TEST_FAULT asks", target.display());
        std::process::abort();
    }
}

/// A competing file arriving after the last check, where a debug fixture asks.
pub(crate) fn appear_at(dir: &Directory, target: &Path, fault: &str) -> io::Result<()> {
    #[cfg(unix)]
    if fault == "create-before-rename"
        && crate::fault::named("symlink-before-rename").is_some_and(|name| {
            target
                .file_name()
                .is_some_and(|file| file.to_string_lossy() == name)
        })
    {
        return rustix::fs::symlinkat("absent-fixture-target", dir.file(), target)
            .map_err(Into::into);
    }
    if crate::fault::named(fault).is_some_and(|name| {
        target
            .file_name()
            .is_some_and(|file| file.to_string_lossy() == name)
    }) {
        dir.open_file(
            target,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o666),
        )?
        .write_all(b"appeared meanwhile\n")?;
    }
    Ok(())
}

/// A Finder tag, say, which a file written anew would otherwise lose.
#[cfg(target_os = "macos")]
fn keep_attributes(from: &File, to: &File) {
    use xattr::FileExt;
    let Ok(names) = from.list_xattr() else {
        return;
    };
    for name in names {
        if let Ok(Some(value)) = from.get_xattr(&name) {
            let _ = to.set_xattr(&name, &value);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keep_attributes(_from: &File, _to: &File) {}

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
pub(crate) fn save_meanwhile(dir: &Directory, target: &Path) {
    if crate::fault::named("save-before-last-look").is_some()
        && target
            .extension()
            .is_some_and(|extension| extension == "md")
        && dir.entry_metadata(target).is_ok()
    {
        let _ = dir
            .open_file(target, OFlags::WRONLY | OFlags::APPEND, Mode::empty())
            .and_then(|mut file| file.write_all(b"saved meanwhile\n"));
    }
}

/// Named so the built-in lists never take it (`*.tmp`), and in the target's
/// own directory, so the rename never crosses a volume.
fn aside_name() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    PathBuf::from(format!(
        ".marfa-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn beside(dir: &Directory) -> io::Result<(File, PathBuf)> {
    loop {
        let path = aside_name();
        match dir.open_file(
            &path,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL,
            Mode::from_raw_mode(0o666),
        ) {
            Ok(file) => return Ok((file, path)),
            // Left by a crashed process that had this id.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

/// Renames `target` out of the way, to a name of the kind [`beside`] makes in
/// its own directory, replacing nothing. Answers that name.
pub(crate) fn set_aside(dir: &Directory, target: &Path) -> io::Result<PathBuf> {
    loop {
        let aside = aside_name();
        match rename_new_at(dir, target, dir, &aside) {
            Ok(()) => return Ok(aside),
            // Left by a crashed process that had this id.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
pub(crate) fn land(
    target: &Path,
    fill: impl FnOnce(&mut File, &Path) -> io::Result<()>,
    still: impl FnOnce(Option<&[u8]>) -> bool,
) -> Result<(), Unlanded> {
    let dir = Directory::open(&target.parent().unwrap().canonicalize()?)?;
    land_at(&dir, Path::new(target.file_name().unwrap()), fill, still)
}

#[cfg(test)]
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    rename_new_at(
        &Directory::open(&from.parent().unwrap().canonicalize()?)?,
        Path::new(from.file_name().unwrap()),
        &Directory::open(&to.parent().unwrap().canonicalize()?)?,
        Path::new(to.file_name().unwrap()),
    )
}

#[cfg(test)]
fn remove(target: &Path, still: impl FnOnce(&[u8]) -> bool) -> io::Result<bool> {
    remove_at(
        &Directory::open(&target.parent().unwrap().canonicalize()?)?,
        Path::new(target.file_name().unwrap()),
        still,
    )
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
    fn an_absent_target_cannot_be_replaced_after_its_last_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        let failed = write(&target, b"from the server", |found| {
            assert!(found.is_none());
            std::fs::write(&target, b"appeared meanwhile").unwrap();
            true
        });
        assert!(matches!(failed, Err(Unlanded::Changed)));
        assert_eq!(std::fs::read(&target).unwrap(), b"appeared meanwhile");
        assert!(leftovers(dir.path()).is_empty());
        std::fs::remove_file(&target).unwrap();
        write(&target, b"from the server", |found| found.is_none()).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
    }

    #[cfg(unix)]
    #[test]
    fn a_move_refuses_existing_files_and_dangling_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("source");
        let to = dir.path().join("destination");
        std::fs::write(&from, b"source").unwrap();
        std::fs::write(&to, b"destination").unwrap();
        assert_eq!(
            rename_new(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&from).unwrap(), b"source");
        assert_eq!(std::fs::read(&to).unwrap(), b"destination");
        std::fs::remove_file(&to).unwrap();
        std::os::unix::fs::symlink("missing", &to).unwrap();
        assert_eq!(
            rename_new(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read_link(&to).unwrap(), Path::new("missing"));
        assert_eq!(std::fs::read(&from).unwrap(), b"source");
        std::fs::remove_file(&to).unwrap();
        rename_new(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"source");
        assert!(!from.exists());
    }

    #[test]
    fn a_write_that_fails_part_way_leaves_the_old_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
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
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
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
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("tool.sh");
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
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
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
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("note.md");
        std::fs::write(&target, b"edited since").unwrap();
        assert!(!remove(&target, |found| found == b"as written").unwrap());
        assert!(target.exists());
        assert!(remove(&target, |found| found == b"edited since").unwrap());
        assert!(!target.exists());
        assert!(!remove(&target, |_| true).unwrap());
    }
    #[test]
    fn publication_and_failed_temp_cleanup_follow_the_retained_parent() {
        for fail in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let path = base.join("child");
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("note.md"), b"owned").unwrap();
            let directory = Directory::open(&path).unwrap();
            let result = land_at(
                &directory,
                Path::new("note.md"),
                |file, temporary| {
                    std::fs::rename(&path, base.join("original"))?;
                    std::fs::create_dir(&path)?;
                    std::fs::write(path.join("note.md"), b"replacement")?;
                    std::fs::write(path.join(temporary), b"replacement temporary")?;
                    file.write_all(b"published")?;
                    if fail {
                        return Err(io::Error::other("fixture stopped before publication"));
                    }
                    Ok(())
                },
                |found| found == Some(b"owned".as_slice()),
            );
            assert_eq!(result.is_err(), fail);
            assert_eq!(std::fs::read(path.join("note.md")).unwrap(), b"replacement");
            let names = leftovers(&path);
            assert_eq!(names.len(), 1);
            assert_eq!(
                std::fs::read(path.join(&names[0])).unwrap(),
                b"replacement temporary"
            );
            assert!(leftovers(&base.join("original")).is_empty());
            assert_eq!(
                std::fs::read(base.join("original/note.md")).unwrap(),
                if fail {
                    b"owned".as_slice()
                } else {
                    b"published".as_slice()
                }
            );
        }
    }
}
