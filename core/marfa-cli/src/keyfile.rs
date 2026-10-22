//! A file that holds a server's address and a key for it, for a watch that
//! runs where no one is signed in to unlock the keychain: `folders watch
//! --key-file`, which `folders autostart on --key-file` writes into the agent.
//! The agent holds the file's path, never what is in it.

use std::io::Read as _;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use marfa_core::folder::Registry;

use crate::error::CliError;

const URL_NAME: &str = "MARFA_API_URL";
const KEY_NAME: &str = "MARFA_API_KEY";

/// The most a key file may hold: it is two short lines.
const LIMIT: u64 = 16 * 1024;

pub struct KeyFile {
    pub url: String,
    pub key: String,
}

fn refuse(path: &Path, why: impl std::fmt::Display) -> CliError {
    CliError::Invalid(format!("the key file {}: {why}", path.display()))
}

/// The file's address and key. Refused, with the reason and never a value,
/// for a file that is a link, that is not the person's own, that others can
/// read, or that lacks either name.
pub fn read(path: &Path) -> Result<KeyFile, CliError> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        // A link could lead anywhere the person did not mean.
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ELOOP) => refuse(path, "is a link: name the file itself"),
            _ if error.kind() == std::io::ErrorKind::NotFound => refuse(path, "does not exist"),
            _ => refuse(path, format!("cannot be read: {error}")),
        })?;
    let meta = file
        .metadata()
        .map_err(|error| refuse(path, format!("cannot be read: {error}")))?;
    if !meta.is_file() {
        return Err(refuse(path, "is not a file"));
    }
    // SAFETY: `geteuid` cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(refuse(path, "belongs to another user"));
    }
    let mode = meta.mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(refuse(
            path,
            format!(
                "can be read by others (mode {mode:03o}): run `chmod 600 {}`",
                path.display()
            ),
        ));
    }
    if meta.len() > LIMIT {
        return Err(refuse(path, "is larger than a key file can be"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|_| refuse(path, "is not text"))?;
    let (mut url, mut key) = (None, None);
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|quote| value.strip_prefix(*quote)?.strip_suffix(*quote))
            .unwrap_or(value);
        match name.trim() {
            URL_NAME => url = Some(value.to_string()),
            KEY_NAME => key = Some(value.to_string()),
            _ => {}
        }
    }
    match (url.filter(|v| !v.is_empty()), key.filter(|v| !v.is_empty())) {
        (Some(url), Some(key)) => Ok(KeyFile { url, key }),
        (None, _) => Err(refuse(path, format!("has no {URL_NAME} line"))),
        (_, None) => Err(refuse(path, format!("has no {KEY_NAME} line"))),
    }
}

/// `path` made absolute, and refused where it lies inside a folder the
/// registry lists or inside `also`, a directory a watch is given, because the
/// watch would send the key to the server as a file of that folder.
pub fn placed(path: &Path, also: Option<&Path>) -> Result<PathBuf, CliError> {
    let absolute = std::path::absolute(path)?;
    let real = std::fs::canonicalize(&absolute).unwrap_or_else(|_| absolute.clone());
    let mut folders: Vec<PathBuf> = also.map(Path::to_path_buf).into_iter().collect();
    if let Some(registry) = Registry::located() {
        // `read` lists what the file says and rewrites nothing; `folders`
        // would drop from the file an entry whose directory is gone.
        let listed = registry.read()?.unwrap_or_default();
        folders.extend(listed.into_iter().map(|folder| folder.dir));
    }
    for folder in folders {
        let dir = std::fs::canonicalize(&folder).unwrap_or_else(|_| folder.clone());
        if real.starts_with(&dir) {
            return Err(refuse(
                &absolute,
                format!(
                    "lies inside the folder {}, which the watch would send to the server: keep it outside every folder",
                    folder.display()
                ),
            ));
        }
    }
    Ok(absolute)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn file(name: &str, mode: u32, text: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("marfa-keyfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn said(error: CliError) -> String {
        match error {
            CliError::Invalid(said) => said,
            other => panic!("not an invalid: {other:?}"),
        }
    }

    #[test]
    fn the_address_and_key_are_read_from_lines_with_comments_quotes_and_export() {
        let path = file(
            "good",
            0o600,
            "# for the folder\nexport MARFA_API_URL=\"https://marfa.example\"\nMARFA_API_KEY='marfa_k_secret'\nOTHER=x\n",
        );
        let read = read(&path).unwrap();
        assert_eq!(read.url, "https://marfa.example");
        assert_eq!(read.key, "marfa_k_secret");
        // Stricter than owner-only is fine.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(super::read(&path).is_ok());
    }

    #[test]
    fn a_file_others_can_read_is_refused_by_its_mode_and_never_shows_the_key() {
        for mode in [0o640, 0o604, 0o644, 0o660] {
            let path = file(
                "loose",
                mode,
                "MARFA_API_URL=https://m.example\nMARFA_API_KEY=marfa_k_secret\n",
            );
            let said = said(read(&path).err().unwrap());
            assert!(said.contains("can be read by others"), "{mode:o}: {said}");
            assert!(said.contains("chmod 600"), "{said}");
            assert!(!said.contains("marfa_k_secret"), "{said}");
        }
        // The witness: owner-only is read.
        let path = file(
            "loose",
            0o600,
            "MARFA_API_URL=https://m.example\nMARFA_API_KEY=marfa_k_secret\n",
        );
        assert!(read(&path).is_ok());
    }

    #[test]
    fn a_link_a_missing_file_and_a_file_lacking_a_name_are_refused() {
        let real = file(
            "real",
            0o600,
            "MARFA_API_URL=https://m.example\nMARFA_API_KEY=k\n",
        );
        let link = real.with_file_name("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(said(read(&link).err().unwrap()).contains("is a link"));
        assert!(
            said(read(&real.with_file_name("absent")).err().unwrap()).contains("does not exist")
        );
        let no_key = file("nokey", 0o600, "MARFA_API_URL=https://m.example\n");
        assert!(said(read(&no_key).err().unwrap()).contains("no MARFA_API_KEY line"));
        let no_url = file("nourl", 0o600, "MARFA_API_KEY=k\nMARFA_API_URL=\n");
        assert!(said(read(&no_url).err().unwrap()).contains("no MARFA_API_URL line"));
    }
}
