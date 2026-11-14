//! What `marfa server install` writes: the Compose file, which is the same
//! for every install, and the two settings files beside it.

use marfa_acl::Exposure;
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
# MARFA_KEY_SALT and MARFA_AUTH_SECRET are made once and never change. Keep a
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

/// The files the installer keeps. Under a root install the account can write only
/// `data/`, so root never follows anything it plants beside them.
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

/// The file has its owner and mode before it holds a byte, and a link is never
/// followed or replaced. Owner and mode are set whether or not the content changed.
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

/// Whether a first install may find `name`: an earlier run's file, or a restored one.
fn is_ours(name: &str) -> bool {
    matches!(name, DOTENV | SETTINGS | UNCONFIRMED | "data")
        || (name.ends_with(".tmp")
            && [DOTENV, SETTINGS, UNCONFIRMED]
                .iter()
                .any(|file| name.starts_with(&format!(".{file}."))))
}

/// Refuses an install folder that is someone else's or that another account could change.
pub fn admit_folder(
    dir: &Path,
    root_install: bool,
    account_gid: Option<u32>,
    native: bool,
) -> Result<(), CliError> {
    // SAFETY: `geteuid` cannot fail.
    admit(dir, root_install, account_gid, native, unsafe {
        libc::geteuid()
    })
}

fn admit(
    dir: &Path,
    root_install: bool,
    account_gid: Option<u32>,
    native: bool,
    user: u32,
) -> Result<(), CliError> {
    let found = match fs::symlink_metadata(dir) {
        Ok(found) => found,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return if root_install {
                check_parents(dir, 0)
            } else if native {
                check_parents(dir, user)
            } else {
                Ok(())
            };
        }
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
        check_parents(dir, 0)?;
    } else {
        if found.uid() != user {
            return Err(CliError::Usage(format!(
                "{} belongs to another account (user {}), so this command will not install into it: choose another --dir",
                dir.display(),
                found.uid()
            )));
        }
        if found.mode() & 0o022 != 0 {
            return Err(CliError::Usage(format!(
                "{} can be written by more than its owner, who could plant files in it: run `chmod go-w` on it, or choose another --dir",
                dir.display()
            )));
        }
        if native {
            check_parents(dir, user)?;
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
    // The account owns `data` in a root install; in any other, the user does.
    let kept: &[&str] = if root_install {
        &[DOTENV, SETTINGS, UNCONFIRMED]
    } else {
        &[DOTENV, SETTINGS, UNCONFIRMED, "data"]
    };
    let owner = if root_install { 0 } else { user };
    for name in kept {
        let path = dir.join(name);
        match fs::symlink_metadata(&path) {
            Ok(found) if found.file_type().is_symlink() => return Err(refused_link(&path)),
            Ok(found) if found.uid() != owner => {
                return Err(CliError::Usage(format!(
                    "{} belongs to another account (user {}), so this command will not use it: remove it, or choose another --dir",
                    path.display(),
                    found.uid()
                )));
            }
            _ => {}
        }
    }
    Ok(())
}

// Path-based writes rely on every ancestor; `O_NOFOLLOW` protects only the final component.
fn check_parents(dir: &Path, trusted: u32) -> Result<(), CliError> {
    let absolute = std::path::absolute(dir)?;
    let folders = marfa_acl::folders_from_root(&absolute).ok_or_else(|| {
        CliError::Usage(format!(
            "{} is not a normalized path: choose another --dir",
            dir.display()
        ))
    })?;
    for current in folders {
        let found = match fs::symlink_metadata(&current) {
            Ok(found) => found,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let shown = current.display();
        let why = match marfa_acl::exposure(&current, &found, trusted)? {
            None => continue,
            Some(Exposure::Link) => format!(
                "{shown} is a link, and the install folder lies below it: choose a --dir that does not pass through one"
            ),
            Some(Exposure::NotFolder) => {
                format!(
                    "{shown} is not a folder, so it cannot hold the install: choose another --dir"
                )
            }
            Some(Exposure::Owner) => format!(
                "{shown} belongs to another account (user {}), and the install folder lies below it: that account could swap the install folder for a link after it was checked. Choose another --dir",
                found.uid()
            ),
            Some(Exposure::Mode) => format!(
                "{shown} can be written by group or others, and the install folder lies below it: they could swap the install folder for a link after it was checked. Run `chmod go-w {shown}`, or choose another --dir"
            ),
            Some(Exposure::Acl) => format!(
                "{shown} has an access control list that lets another account change what it holds, and the install folder lies below it: that account could swap the install folder for a link after it was checked. Choose another --dir"
            ),
        };
        return Err(CliError::Usage(why));
    }
    Ok(())
}

/// Root changes only what it made or checked itself, through descriptors, and
/// touches nothing inside `data`, which the account controls.
pub fn prepare_root_folder(dir: &Path, account: Identity) -> Result<(), CliError> {
    check_parents(dir, 0)?;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o750).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    check_parents(dir, 0)?;
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
        // The install folder's path is real by the time it is checked.
        fs::canonicalize(dir).unwrap()
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
        admit_folder(&folder, false, None, true).unwrap();
        fs::create_dir(&folder).unwrap();
        admit_folder(&folder, false, None, true).unwrap();
        // What a restore puts there.
        fs::write(folder.join("marfa.env"), "").unwrap();
        fs::create_dir(folder.join("data")).unwrap();
        admit_folder(&folder, false, None, true).unwrap();
        // Someone's folder.
        fs::write(folder.join("notes.txt"), "mine").unwrap();
        let error = admit_folder(&folder, false, None, true)
            .unwrap_err()
            .to_string();
        assert!(error.contains("notes.txt"), "{error}");
        // An earlier install keeps whatever else the person put beside it.
        fs::write(folder.join(".env"), "MARFA_NAME=x\n").unwrap();
        admit_folder(&folder, false, None, true).unwrap();
        // A file is not a folder.
        let file = dir.join("file");
        fs::write(&file, "").unwrap();
        assert!(admit_folder(&file, false, None, true).is_err());
    }

    #[test]
    fn a_folder_the_account_controls_is_not_a_root_install() {
        let dir = scratch("account");
        let mine = unsafe { libc::geteuid() };
        // A folder owned by anyone but root is refused for the account's install.
        if mine != 0 {
            let error = admit_folder(&dir, true, Some(988), true)
                .unwrap_err()
                .to_string();
            assert!(error.contains("not owned by root"), "{error}");
        }
    }

    #[test]
    fn a_folder_above_the_install_folder_that_others_can_write_is_refused() {
        let me = unsafe { libc::geteuid() };
        let top = scratch("parents");
        let parent = top.join("parent");
        let dir = parent.join("marfa");
        fs::create_dir_all(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        // The witness: with the parent closed, the same path is accepted.
        check_parents(&dir, me).unwrap();
        for open in [0o775, 0o757, 0o777] {
            fs::set_permissions(&parent, fs::Permissions::from_mode(open)).unwrap();
            let error = check_parents(&dir, me).unwrap_err().to_string();
            assert!(error.contains(&parent.display().to_string()), "{error}");
            assert!(error.contains("written by group or others"), "{error}");
        }
        // The same when the install folder is there already.
        fs::create_dir(&dir).unwrap();
        assert!(check_parents(&dir, me).is_err());
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        check_parents(&dir, me).unwrap();
    }

    #[test]
    fn a_folder_above_the_install_folder_is_refused_only_for_an_acl_that_writes() {
        use marfa_acl::testing::{Grant, let_another_account};
        let me = unsafe { libc::geteuid() };
        let top = scratch("acl-parents");
        for (grant, refused) in [
            (Grant::Read, false),
            (Grant::InheritRead, false),
            (Grant::Write, true),
            (Grant::InheritWrite, true),
        ] {
            let parent = top.join(format!("{grant:?}"));
            let dir = parent.join("marfa");
            fs::create_dir_all(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
            check_parents(&dir, me).unwrap();
            if !let_another_account(&parent, grant) {
                crate::errln!("skipped: this file system keeps no ACLs");
                return;
            }
            let checked = check_parents(&dir, me);
            if !refused {
                checked.unwrap();
                continue;
            }
            let error = checked.unwrap_err().to_string();
            assert!(error.contains(&parent.display().to_string()), "{error}");
        }
    }

    #[test]
    fn an_install_of_ones_own_refuses_a_folder_above_it_that_others_can_write() {
        let me = unsafe { libc::geteuid() };
        let top = scratch("own-parents");
        let parent = top.join("parent");
        let dir = parent.join("marfa");
        fs::create_dir_all(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        admit(&dir, false, None, true, me).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o775)).unwrap();
        let error = admit(&dir, false, None, true, me).unwrap_err().to_string();
        assert!(error.contains("written by group or others"), "{error}");
        // A Docker install keeps its socket in the container, so its folder's parents are not judged.
        admit(&dir, false, None, false, me).unwrap();
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(admit(&dir, false, None, true, me).is_err());
    }

    #[test]
    fn a_folder_above_the_install_folder_that_another_account_owns_is_refused() {
        let me = unsafe { libc::geteuid() };
        let top = scratch("owner");
        let dir = top.join("marfa");
        fs::create_dir(&dir).unwrap();
        // Nobody who is not trusted owns the folders above: from another
        // account's point of view, this account is the stranger.
        let error = check_parents(&dir, me.wrapping_add(1))
            .unwrap_err()
            .to_string();
        assert!(error.contains("belongs to another account"), "{error}");
        check_parents(&dir, me).unwrap();
    }

    #[test]
    fn a_link_above_the_install_folder_is_refused() {
        let me = unsafe { libc::geteuid() };
        let top = scratch("parent-link");
        let real = top.join("real");
        fs::create_dir(&real).unwrap();
        let link = top.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let error = check_parents(&link.join("marfa"), me)
            .unwrap_err()
            .to_string();
        assert!(error.contains("is a link"), "{error}");
        check_parents(&real.join("marfa"), me).unwrap();
    }

    #[test]
    fn a_root_install_is_refused_below_a_folder_others_can_write() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let top = scratch("root-parents");
        let error = admit_folder(&top.join("marfa"), true, Some(988), true)
            .unwrap_err()
            .to_string();
        assert!(error.contains("belongs to another account"), "{error}");
    }

    #[test]
    fn a_folder_another_account_owns_is_not_installed_into() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("user-owner");
        admit(&dir, false, None, true, me).unwrap();
        let error = admit(&dir, false, None, true, me.wrapping_add(1))
            .unwrap_err()
            .to_string();
        assert!(error.contains("belongs to another account"), "{error}");
    }

    #[test]
    fn a_folder_others_can_write_is_not_installed_into() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("user-open");
        for open in [0o770, 0o707, 0o777] {
            fs::set_permissions(&dir, fs::Permissions::from_mode(open)).unwrap();
            let error = admit(&dir, false, None, true, me).unwrap_err().to_string();
            assert!(error.contains("written by more than its owner"), "{error}");
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        admit(&dir, false, None, true, me).unwrap();
    }

    #[test]
    fn a_restore_that_another_account_owns_is_not_used() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("user-restore");
        fs::write(dir.join("marfa.env"), "").unwrap();
        fs::create_dir(dir.join("data")).unwrap();
        admit(&dir, false, None, true, me).unwrap();
        // Seen from another account, the folder and what is in it are strangers'.
        let error = admit(&dir, false, None, true, me.wrapping_add(1))
            .unwrap_err()
            .to_string();
        assert!(error.contains("belongs to another account"), "{error}");
        // A link where `data` should be is refused, not followed.
        let linked = scratch("user-restore-link");
        std::os::unix::fs::symlink(&dir, linked.join("data")).unwrap();
        let error = admit(&linked, false, None, true, me)
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic link"), "{error}");
    }

    /// Needs root to chown, so it runs in the container that tests the root
    /// install, and passes without doing anything elsewhere.
    #[test]
    fn a_file_or_data_of_a_restore_that_another_account_owns_is_not_used() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        for name in ["marfa.env", "data"] {
            let dir = scratch("user-restore-chown");
            let path = dir.join(name);
            if name == "data" {
                fs::create_dir(&path).unwrap();
            } else {
                fs::write(&path, "").unwrap();
            }
            admit(&dir, false, None, true, 0).unwrap();
            std::os::unix::fs::chown(&path, Some(41_003), None).unwrap();
            let error = admit(&dir, false, None, true, 0).unwrap_err().to_string();
            assert!(error.contains(&path.display().to_string()), "{error}");
            assert!(error.contains("belongs to another account"), "{error}");
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
