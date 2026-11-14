use crate::error::CliError;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub(super) struct Partial {
    file: File,
    path: PathBuf,
    target: PathBuf,
    kept: bool,
}

impl Partial {
    pub(super) fn beside(target: &Path) -> Result<Partial, CliError> {
        let name = target
            .file_name()
            .ok_or_else(|| CliError::Invalid(format!("{} names no file", target.display())))?;
        let cannot = |error: io::Error| {
            CliError::Invalid(format!("cannot write {}: {error}", target.display()))
        };
        let mut attempt = 0u32;
        loop {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.subsec_nanos());
            let path = target.with_file_name(format!(
                ".{}.partial-{}-{nanos}",
                name.to_string_lossy(),
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Partial {
                        file,
                        path,
                        target: target.to_path_buf(),
                        kept: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempt < 8 => {
                    attempt += 1;
                }
                Err(error) => return Err(cannot(error)),
            }
        }
    }

    pub(super) fn copy_from(&mut self, reader: &mut impl Read) -> io::Result<u64> {
        let written = io::copy(reader, &mut self.file)?;
        self.file.sync_all()?;
        Ok(written)
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn publish(mut self) -> Result<(), CliError> {
        std::fs::rename(&self.path, &self.target).map_err(|error| {
            CliError::Invalid(format!("cannot write {}: {error}", self.target.display()))
        })?;
        self.kept = true;
        Ok(())
    }

    pub(super) fn release(mut self) -> PathBuf {
        self.kept = true;
        std::mem::take(&mut self.path)
    }

    pub(super) fn discard(mut self) -> String {
        self.kept = true;
        match std::fs::remove_file(&self.path) {
            Ok(()) => "and the partial file was removed".to_string(),
            Err(_) => format!("and the partial file is left at {}", self.path.display()),
        }
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        if !self.kept {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Partial;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_partial_file_is_owner_only_and_gone_unless_published() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.bin");
        std::fs::write(&target, "earlier").unwrap();
        let mut dropped = Partial::beside(&target).unwrap();
        dropped.copy_from(&mut "new".as_bytes()).unwrap();
        let mode = std::fs::metadata(dropped.path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        drop(dropped);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "earlier");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

        // The witness: published, the same file takes the target's place.
        let mut kept = Partial::beside(&target).unwrap();
        kept.copy_from(&mut "new".as_bytes()).unwrap();
        kept.publish().unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
