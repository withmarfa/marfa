//! What `marfa server install` writes: the Compose file, which is the same
//! for every install, and the two settings files beside it.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use super::account::{self, Identity};
use super::service::Manager;
use crate::error::CliError;

pub const COMPOSE: &str = "compose.yaml";
/// What the install records, and what Compose reads for a Docker install. It
/// holds no secret.
pub const DOTENV: &str = ".env";
/// Read by the server: its secrets and the proxy it trusts.
pub const SETTINGS: &str = "marfa.env";
/// Present from the run that makes the secrets until an install succeeds. It
/// holds no secret.
pub const UNCONFIRMED: &str = ".secrets-unconfirmed";

pub const UNCONFIRMED_NOTE: &str = "\
# Written by `marfa server install` with the secrets in marfa.env. Until an
# install succeeds, every install tells you to keep a copy of marfa.env,
# unless it runs with --external-settings. The first install that succeeds
# removes this file.
";

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
# What `marfa server` records about this install; the server does not read
# it. Change a value, then run `marfa server install` again.";

pub const SETTINGS_HEADER: &str = "\
# The server's settings: https://docs.marfa.so/run/settings
# API_KEY_SALT and MARFA_AUTH_SECRET are made once and never change. Keep a
# copy of this file outside this folder: neither secret is stored in the data,
# and a server started on the data without them refuses every key.";

/// Who owns a file and who can read it. A file with no owner named belongs to
/// whoever makes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Perms {
    pub mode: u32,
    pub owner: Option<(u32, u32)>,
}

impl Perms {
    pub const PRIVATE: Perms = Perms {
        mode: 0o600,
        owner: None,
    };
    pub const READABLE: Perms = Perms {
        mode: 0o644,
        owner: None,
    };
}

/// The files the installer keeps. When root installs a server that runs as the
/// `marfa` account, root owns every one of them and the account reads only
/// what it must: the account can write nowhere but `data/`, so nothing it
/// plants beside them is ever followed by root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kept {
    pub settings: Perms,
    pub dotenv: Perms,
    pub marker: Perms,
}

pub fn kept(account: Option<Identity>) -> Kept {
    match account {
        Some(account) => {
            let readable = Perms {
                mode: 0o640,
                owner: Some((0, account.gid)),
            };
            Kept {
                settings: readable,
                dotenv: readable,
                marker: Perms {
                    mode: 0o600,
                    owner: Some((0, 0)),
                },
            }
        }
        None => Kept {
            settings: Perms::PRIVATE,
            dotenv: Perms::READABLE,
            marker: Perms::READABLE,
        },
    }
}

/// What an install of this service manager keeps.
pub fn kept_for(manager: Option<Manager>) -> Kept {
    kept(
        (manager == Some(Manager::SystemdSystem))
            .then(|| account::lookup(account::NAME))
            .flatten(),
    )
}

fn refused_link(path: &Path) -> CliError {
    CliError::Usage(format!(
        "{} is a symbolic link, which this command does not follow: replace it with the file itself",
        path.display()
    ))
}

fn no_follow() -> i32 {
    libc::O_NOFOLLOW
}

/// A file of the install folder's, read without following a link. `None` when
/// there is no such file.
pub fn read_regular(path: &Path) -> Result<Option<String>, CliError> {
    match fs::symlink_metadata(path) {
        Ok(found) if found.file_type().is_symlink() => return Err(refused_link(path)),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ELOOP) => refused_link(path),
            _ => error.into(),
        })?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

/// Gives the open file its owner and mode. On the descriptor, so that the file
/// that is changed is the file that was opened.
fn settle(file: &fs::File, perms: Perms) -> std::io::Result<()> {
    let found = file.metadata()?;
    if let Some((uid, gid)) = perms.owner
        && (found.uid() != uid || found.gid() != gid)
    {
        std::os::unix::fs::fchown(file, Some(uid), Some(gid))?;
    }
    if found.mode() & 0o7777 != perms.mode {
        file.set_permissions(fs::Permissions::from_mode(perms.mode))?;
    }
    Ok(())
}

/// Gives an existing file of the install folder's its owner and mode, unless
/// it is a link.
pub fn settle_path(path: &Path, perms: Perms) -> Result<(), CliError> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(refused_link(path));
        }
        Err(error) => return Err(error.into()),
    };
    settle(&file, perms).map_err(|error| {
        CliError::Io(std::io::Error::new(
            error.kind(),
            format!(
                "cannot set the owner and mode of {}: {error}",
                path.display()
            ),
        ))
    })
}

/// Writes `content` to `path` when it differs, through a temporary file in the
/// same folder, so a stop part-way leaves the old file whole. The file has its
/// owner and mode before it holds a byte, and a link is never followed or
/// replaced. Whether the content changed is the answer; the owner and mode are
/// set either way.
pub fn write_if_changed(path: &Path, content: &str, perms: Perms) -> Result<bool, CliError> {
    if read_regular(path)?.is_some_and(|existing| existing == content) {
        settle_path(path, perms)?;
        return Ok(false);
    }
    let folder = path.parent().unwrap_or(Path::new("."));
    let temporary = folder.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(no_follow())
            .open(&temporary)?;
        settle(&file, perms)?;
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

/// Whether `name` in the install folder is something a first install may
/// find: what an earlier run of this command left, or a restored settings
/// file or data folder.
fn is_ours(name: &str) -> bool {
    matches!(name, DOTENV | SETTINGS | UNCONFIRMED | "data")
        || (name.ends_with(".tmp")
            && [DOTENV, SETTINGS, UNCONFIRMED]
                .iter()
                .any(|file| name.starts_with(&format!(".{file}."))))
}

/// An install folder is absent, empty, or one an earlier install of this
/// command made (it holds `.env`); a folder that also holds the settings file
/// or the data of a restore is one too. Anything else is someone's, and this
/// command writes nothing into it. When the server runs as the account, root
/// must own the folder and nobody else can write to it, and every file the
/// command keeps in it is root's.
pub fn admit_folder(
    dir: &Path,
    root_install: bool,
    account_gid: Option<u32>,
) -> Result<(), CliError> {
    let found = match fs::symlink_metadata(dir) {
        Ok(found) => found,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !found.is_dir() {
        return Err(CliError::Usage(format!(
            "{} is not a folder: choose another --dir",
            dir.display()
        )));
    }
    if root_install {
        if found.uid() != 0 || (found.gid() != 0 && Some(found.gid()) != account_gid) {
            return Err(CliError::Usage(format!(
                "{} is not owned by root (it belongs to user {} and group {}): the {} account runs this server and must not control the folder. Choose another --dir, or give this one to root",
                dir.display(),
                found.uid(),
                found.gid(),
                account::NAME
            )));
        }
        if found.mode() & 0o022 != 0 {
            return Err(CliError::Usage(format!(
                "{} can be written by more than its owner: run `chmod go-w` on it, or choose another --dir",
                dir.display()
            )));
        }
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    if !names.iter().any(|name| name == DOTENV)
        && let Some(other) = names.iter().find(|name| !is_ours(name))
    {
        return Err(CliError::Usage(format!(
            "{} already holds {other} and no install made by this command: choose an empty or new --dir",
            dir.display()
        )));
    }
    if root_install {
        for name in [DOTENV, SETTINGS, UNCONFIRMED] {
            let path = dir.join(name);
            match fs::symlink_metadata(&path) {
                Ok(found) if found.file_type().is_symlink() => return Err(refused_link(&path)),
                Ok(found) if found.uid() != 0 => {
                    return Err(CliError::Usage(format!(
                        "{} belongs to another account, so this command will not use it: remove it, or choose another --dir",
                        path.display()
                    )));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// Makes the folder a root install keeps (root's, group `marfa`, no access for
/// anyone else) and its `data` folder, which is the account's alone. Root
/// changes only what it made or checked itself, through descriptors: nothing
/// inside `data` is touched, because the account controls it.
pub fn prepare_root_folder(dir: &Path, account: Identity) -> Result<(), CliError> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o750).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let folder = open_folder(dir)?;
    let found = folder.metadata()?;
    if found.uid() != 0 {
        return Err(CliError::Usage(format!(
            "{} is not owned by root: choose another --dir",
            dir.display()
        )));
    }
    std::os::unix::fs::fchown(&folder, Some(0), Some(account.gid))?;
    folder.set_permissions(fs::Permissions::from_mode(0o750))?;

    let data = dir.join("data");
    match fs::symlink_metadata(&data) {
        Ok(found) if found.is_dir() && found.uid() == account.uid => Ok(()),
        Ok(found) if found.file_type().is_symlink() => Err(refused_link(&data)),
        Ok(_) => Err(CliError::Usage(format!(
            "{0} must be a folder that the {1} account owns (for restored data, `chown -R {1}:{1} {0}`)",
            data.display(),
            account::NAME,
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::DirBuilder::new().mode(0o700).create(&data)?;
            let made = open_folder(&data)?;
            std::os::unix::fs::fchown(&made, Some(account.uid), Some(account.gid))?;
            made.set_permissions(fs::Permissions::from_mode(0o700))?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// A folder opened without following a link.
fn open_folder(path: &Path) -> Result<fs::File, CliError> {
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(no_follow() | libc::O_DIRECTORY)
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => CliError::Usage(format!(
                "{} is not a folder this command can use (a link, or not a folder)",
                path.display()
            )),
            _ => error.into(),
        })
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

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_private_file_is_never_wider_than_its_owner() {
        let dir = scratch("private");
        let path = dir.join("marfa.env");
        assert!(write_if_changed(&path, "A=1\n", Perms::PRIVATE).unwrap());
        assert_eq!(mode(&path), 0o600);
        assert!(!write_if_changed(&path, "A=1\n", Perms::PRIVATE).unwrap());
        assert!(write_if_changed(&path, "A=2\n", Perms::PRIVATE).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=2\n");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn a_wide_file_is_narrowed_whether_or_not_its_content_changes() {
        let dir = scratch("narrow");
        let path = dir.join("marfa.env");
        fs::write(&path, "A=1\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!write_if_changed(&path, "A=1\n", Perms::PRIVATE).unwrap());
        assert_eq!(mode(&path), 0o600);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(write_if_changed(&path, "A=2\n", Perms::PRIVATE).unwrap());
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn a_link_is_neither_read_nor_written_through_nor_replaced() {
        let dir = scratch("link");
        let target = dir.join("elsewhere");
        fs::write(&target, "A=1\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        let path = dir.join("marfa.env");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        for content in ["A=1\n", "A=2\n"] {
            let error = write_if_changed(&path, content, Perms::PRIVATE)
                .unwrap_err()
                .to_string();
            assert!(error.contains("symbolic link"), "{error}");
        }
        assert!(read_regular(&path).is_err());
        assert!(settle_path(&path, Perms::PRIVATE).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "A=1\n");
        assert_eq!(mode(&target), 0o644, "the target was not narrowed");
        assert!(
            fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // The witness: the same file as a regular one is written.
        fs::remove_file(&path).unwrap();
        assert!(write_if_changed(&path, "A=2\n", Perms::PRIVATE).unwrap());
    }

    #[test]
    fn a_missing_file_reads_as_none() {
        let dir = scratch("none");
        assert_eq!(read_regular(&dir.join("absent")).unwrap(), None);
    }

    #[test]
    fn a_root_install_keeps_root_files_that_the_account_can_read_only_when_it_must() {
        let account = Identity { uid: 990, gid: 988 };
        let kept = kept(Some(account));
        assert_eq!(kept.settings, kept.dotenv);
        assert_eq!(kept.settings.mode, 0o640);
        assert_eq!(kept.settings.owner, Some((0, 988)));
        assert_eq!(kept.marker.mode, 0o600);
        assert_eq!(kept.marker.owner, Some((0, 0)));
        let mine = super::kept(None);
        assert_eq!(
            (mine.settings, mine.dotenv),
            (Perms::PRIVATE, Perms::READABLE)
        );
    }

    #[test]
    fn an_install_folder_is_absent_empty_or_an_earlier_install() {
        let dir = scratch("admit");
        let folder = dir.join("folder");
        admit_folder(&folder, false, None).unwrap();
        fs::create_dir(&folder).unwrap();
        admit_folder(&folder, false, None).unwrap();
        // What a restore puts there.
        fs::write(folder.join("marfa.env"), "").unwrap();
        fs::create_dir(folder.join("data")).unwrap();
        admit_folder(&folder, false, None).unwrap();
        // Someone's folder.
        fs::write(folder.join("notes.txt"), "mine").unwrap();
        let error = admit_folder(&folder, false, None).unwrap_err().to_string();
        assert!(error.contains("notes.txt"), "{error}");
        // An earlier install keeps whatever else the person put beside it.
        fs::write(folder.join(".env"), "MARFA_NAME=x\n").unwrap();
        admit_folder(&folder, false, None).unwrap();
        // A file is not a folder.
        let file = dir.join("file");
        fs::write(&file, "").unwrap();
        assert!(admit_folder(&file, false, None).is_err());
    }

    #[test]
    fn a_folder_the_account_controls_is_not_a_root_install() {
        let dir = scratch("account");
        let mine = unsafe { libc::geteuid() };
        // A folder owned by anyone but root is refused for the account's install.
        if mine != 0 {
            let error = admit_folder(&dir, true, Some(988)).unwrap_err().to_string();
            assert!(error.contains("not owned by root"), "{error}");
        }
    }

    /// Needs root to chown, so it runs in the container that tests the root
    /// install, and passes without doing anything elsewhere.
    #[test]
    fn the_root_folder_is_root_owned_and_only_its_data_belongs_to_the_account() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        use std::os::unix::fs::MetadataExt;
        let account = account::Identity {
            uid: 41_001,
            gid: 41_002,
        };
        let dir = scratch("root-layout").join("marfa");
        prepare_root_folder(&dir, account).unwrap();
        let folder = fs::metadata(&dir).unwrap();
        assert_eq!((folder.uid(), folder.gid()), (0, 41_002));
        assert_eq!(mode(&dir), 0o750);
        let data = fs::metadata(dir.join("data")).unwrap();
        assert_eq!((data.uid(), data.gid()), (41_001, 41_002));
        assert_eq!(mode(&dir.join("data")), 0o700);

        // Data that is there already, whatever is in it, is left as it is.
        fs::write(dir.join("data/marfa.db"), "rows").unwrap();
        std::os::unix::fs::chown(dir.join("data/marfa.db"), Some(41_001), Some(41_002)).unwrap();
        prepare_root_folder(&dir, account).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("data/marfa.db")).unwrap(),
            "rows"
        );

        // A link where the data should be is refused, not followed.
        let elsewhere = scratch("root-elsewhere");
        fs::remove_dir_all(dir.join("data")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join("data")).unwrap();
        let error = prepare_root_folder(&dir, account).unwrap_err().to_string();
        assert!(error.contains("link"), "{error}");
        assert_ne!(fs::metadata(&elsewhere).unwrap().uid(), 41_001);

        // A folder another account owns is never taken over.
        let theirs = scratch("root-theirs");
        std::os::unix::fs::chown(&theirs, Some(41_003), None).unwrap();
        let error = prepare_root_folder(&theirs, account)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not owned by root"), "{error}");
        assert_eq!(fs::metadata(&theirs).unwrap().uid(), 41_003);
    }
}
