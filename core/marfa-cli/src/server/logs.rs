//! The server's output on a Mac, in a file of bounded size.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// The size at which the log is moved aside.
pub const LIMIT: u64 = 10 * 1024 * 1024;

/// A log that keeps one older file, `<name>.1`, beside the current one.
pub struct RotatingLog {
    path: PathBuf,
    file: File,
    size: u64,
    limit: u64,
}

fn open(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}

impl RotatingLog {
    pub fn open(path: &Path, limit: u64) -> io::Result<RotatingLog> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let file = open(path)?;
        let size = file.metadata()?.len();
        Ok(RotatingLog {
            path: path.to_path_buf(),
            file,
            size,
            limit,
        })
    }

    fn older(&self) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(".1");
        PathBuf::from(name)
    }

    /// Moves a full log aside. A log that cannot be moved is written on, so
    /// the server's output is never lost to a full-file check.
    fn rotate(&mut self) {
        if std::fs::rename(&self.path, self.older()).is_err() {
            return;
        }
        if let Ok(file) = open(&self.path) {
            self.file = file;
            self.size = 0;
        }
    }

    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.size >= self.limit {
            self.rotate();
        }
        self.file.write_all(bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marfa-logs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_full_log_is_moved_aside_and_one_older_file_is_kept() {
        let dir = scratch("rotate");
        let path = dir.join("Marfa").join("t.log");
        let mut log = RotatingLog::open(&path, 10).unwrap();
        log.write(b"0123456789").unwrap();
        log.write(b"first\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first\n");
        assert_eq!(
            std::fs::read(dir.join("Marfa").join("t.log.1")).unwrap(),
            b"0123456789"
        );
        log.write(b"0123456789").unwrap();
        log.write(b"second\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second\n");
        assert_eq!(
            std::fs::read(dir.join("Marfa").join("t.log.1")).unwrap(),
            b"first\n0123456789"
        );
        assert_eq!(std::fs::read_dir(dir.join("Marfa")).unwrap().count(), 2);
    }

    #[test]
    fn a_log_that_is_not_full_only_grows() {
        let dir = scratch("grow");
        let path = dir.join("t.log");
        let mut log = RotatingLog::open(&path, 100).unwrap();
        log.write(b"a\n").unwrap();
        log.write(b"b\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a\nb\n");
        assert!(!dir.join("t.log.1").exists());
    }

    #[test]
    fn a_log_reopened_counts_what_it_already_holds() {
        let dir = scratch("reopen");
        let path = dir.join("t.log");
        RotatingLog::open(&path, 8).unwrap().write(b"12345678").unwrap();
        let mut again = RotatingLog::open(&path, 8).unwrap();
        again.write(b"x").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"x");
        assert_eq!(std::fs::read(dir.join("t.log.1")).unwrap(), b"12345678");
    }
}
