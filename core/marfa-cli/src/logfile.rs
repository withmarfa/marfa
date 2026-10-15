//! A watch's output written to a file of bounded size, for a watch that a
//! service manager runs with no terminal to print to.

use std::fs::{DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::CliError;
use crate::interrupt;

/// The size at which the file is moved aside and started afresh.
pub const LIMIT: u64 = 1024 * 1024;

/// How often a running watch looks at the file's size.
const LOOK: Duration = Duration::from_secs(10);

/// Points standard output and standard error at `path`, moving a file that
/// has reached [`LIMIT`] aside first, and goes on doing so while the process
/// runs. Call before the command makes any thread but those that
/// `interrupt::spawn_apart`.
pub fn redirect(path: &Path) -> Result<(), CliError> {
    let path = std::path::absolute(path)?;
    if std::fs::metadata(&path).is_ok_and(|file| file.len() >= LIMIT) {
        set_aside(&path)?;
    }
    attach(&path)?;
    eprintln!(
        "{} folders watch started, process {}",
        now(),
        std::process::id()
    );
    interrupt::spawn_apart("log", move || {
        loop {
            std::thread::sleep(LOOK);
            if attached_len().is_some_and(|len| len >= LIMIT) {
                // A file that cannot be moved or opened now is tried again at
                // the next look, and the output goes on to the one attached.
                let _ = set_aside(&path).and_then(|()| attach(&path));
            }
        }
    })?;
    Ok(())
}

/// The name a full file is moved to, replacing the one before it.
pub fn older(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// A file someone removed is no failure: the next one is opened afresh.
fn set_aside(path: &Path) -> io::Result<()> {
    match std::fs::rename(path, older(path)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn attach(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    // The output names folders' directories, so it is the person's alone.
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    io::stdout().flush()?;
    io::stderr().flush()?;
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        // SAFETY: both descriptors are open; `dup2` replaces the target in one
        // step, so a write from another thread lands in one file or the other.
        if unsafe { libc::dup2(file.as_raw_fd(), target) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The size of the file standard output now writes to, which is the one
/// attached even after someone removed or moved it.
fn attached_len() -> Option<u64> {
    // SAFETY: `stat` is written by `fstat` before it is read.
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        (libc::fstat(libc::STDOUT_FILENO, &mut stat) == 0).then_some(stat.st_size as u64)
    }
}

fn now() -> String {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(since.as_secs() as i64, since.subsec_nanos())
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_file_is_moved_aside_over_the_one_before() {
        let dir = std::env::temp_dir().join(format!("marfa-cli-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("folder-watch.log");
        std::fs::write(older(&path), "oldest").unwrap();
        std::fs::write(&path, "older").unwrap();
        set_aside(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(older(&path)).unwrap(), "older");
        // Nothing to move is no failure.
        set_aside(&path).unwrap();
        assert_eq!(std::fs::read_to_string(older(&path)).unwrap(), "older");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_older_file_adds_one_to_the_name() {
        assert_eq!(
            older(Path::new("/logs/folder-watch.log")),
            Path::new("/logs/folder-watch.log.1")
        );
    }
}
