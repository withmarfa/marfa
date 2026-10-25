//! What `marfa server install` writes: the Compose file, which is the same
//! for every install, and the two settings files beside it.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use crate::error::CliError;

pub const COMPOSE: &str = "compose.yaml";
/// Read by Compose itself: the name, release and port. It holds no secret.
pub const DOTENV: &str = ".env";
/// Read by the server: its secrets and its address.
pub const SETTINGS: &str = "marfa.env";

pub const COMPOSE_FILE: &str = "\
# Written by `marfa server install`, and the same for every install. Change
# the release, the port and the name in .env, and the server's own settings in
# marfa.env. Without the command: `docker network create \"${MARFA_NAME}-net\"`
# once, then `docker compose up -d` in this folder.
name: ${MARFA_NAME}

services:
  server:
    image: ghcr.io/withmarfa/marfa-server:${MARFA_RELEASE}
    container_name: ${MARFA_NAME}
    restart: unless-stopped
    env_file: marfa.env
    ports:
      # Only this machine reaches the port directly. A proxy or tunnel on this
      # machine is how anything else does.
      - \"127.0.0.1:${MARFA_PORT}:8600\"
    volumes:
      - data:/data
    networks:
      - private

networks:
  private:
    name: ${MARFA_NAME}-net
    external: true

volumes:
  data:
    name: ${MARFA_NAME}-data
";

pub const DOTENV_HEADER: &str = "\
# Read by Docker Compose, not by the server. Change a value, then run
# `marfa server install` again (or `docker compose up -d`).";

pub const SETTINGS_HEADER: &str = "\
# The server's settings: https://docs.marfa.so/run/settings
# API_KEY_SALT and MARFA_AUTH_SECRET are made once and never change. Keep a
# copy of this file outside this folder: neither secret is stored in the data,
# and a server started on the data without them refuses every key.";

/// Writes `content` to `path` when it differs, through a temporary file in the
/// same folder, so a stop part-way leaves the old file whole. A new file is
/// readable by its owner only before it holds a byte. Whether the file changed
/// is the answer.
pub fn write_if_changed(path: &Path, content: &str, private: bool) -> Result<bool, CliError> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(false);
    }
    let folder = path.parent().unwrap_or(Path::new("."));
    let temporary = folder.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let mode = if private { 0o600 } else { 0o644 };
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(true)
}

/// The settings file is readable by its owner only, whatever it was before.
pub fn keep_private(path: &Path) -> Result<(), CliError> {
    if path.exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("marfa-files-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_private_file_is_never_wider_than_its_owner() {
        let dir = scratch("private");
        let path = dir.join("marfa.env");
        assert!(write_if_changed(&path, "A=1\n", true).unwrap());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!write_if_changed(&path, "A=1\n", true).unwrap());
        assert!(write_if_changed(&path, "A=2\n", true).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=2\n");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn a_wide_file_is_narrowed() {
        let dir = scratch("narrow");
        let path = dir.join("marfa.env");
        fs::write(&path, "A=1\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        keep_private(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
