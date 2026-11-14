//! The database, its side files and the blob folder are readable and writable by the server's
//! account alone. The server changes the mode and access control list only of what is its own,
//! and never through a symbolic link; what it cannot make private refuses the start.

use std::ffi::{CString, OsStr};
use std::fs::{DirBuilder, File, Metadata, OpenOptions, Permissions};
use std::io::ErrorKind;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::failure::Failure;
use crate::settings::{DatabasePath, secrets_file};

const OTHERS: u32 = 0o077;
const OWNER: u32 = 0o700;

/// Makes every file and folder the process creates from now on private, SQLite's included.
pub fn take_umask() {
    // SAFETY: `umask` takes a mask and cannot fail.
    unsafe {
        libc::umask(0o077);
    }
}

fn me() -> u32 {
    // SAFETY: `geteuid` takes nothing and cannot fail.
    unsafe { libc::geteuid() }
}

fn refused(path: &Path, why: impl std::fmt::Display) -> Failure {
    Failure::start(format!("{} {why}", path.display()))
}

/// Makes the database's folder private, when it is not there. A folder already there is
/// never changed, since it may hold what is not the server's.
pub fn make_data_folder(database: &DatabasePath) -> Result<(), Failure> {
    let Some(file) = database.file() else {
        return Ok(());
    };
    let Some(folder) = file
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
    else {
        return Ok(());
    };
    match std::fs::symlink_metadata(folder) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        _ => return Ok(()),
    }
    let not_made = |error| refused(folder, format_args!("could not be made: {error}"));
    if let Some(parent) = folder
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        DirBuilder::new()
            .recursive(true)
            .mode(OWNER)
            .create(parent)
            .map_err(not_made)?;
    }
    match DirBuilder::new().mode(OWNER).create(folder) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(not_made(error)),
    }
    let Some(made) = open(folder, true)? else {
        return Ok(());
    };
    let found = read(&made, folder)?;
    if found.uid() == me() {
        close(&made, &found, folder)?;
    }
    Ok(())
}

/// What the server keeps, checked before the database and the blob folder open and again after.
pub struct Kept {
    files: Vec<PathBuf>,
    blobs: PathBuf,
    blobs_made: bool,
}

impl Kept {
    /// Refuses the start before anything is opened through a link or made where another account
    /// could read it.
    pub fn closed(database_path: &DatabasePath, blobs: &Path) -> Result<Kept, Failure> {
        let me = me();
        let mut files = match database_path.file() {
            Some(database) => {
                passes_nothing_on(&database_path.folder(), me)?;
                let beside = |suffix: &str| {
                    let mut name = database.clone().into_os_string();
                    name.push(suffix);
                    PathBuf::from(name)
                };
                let mut files: Vec<PathBuf> = [
                    "-wal",
                    "-shm",
                    "-journal",
                    ".before-upgrade",
                    ".before-upgrade.partial",
                ]
                .iter()
                .map(|suffix| beside(suffix))
                .collect();
                files.insert(0, database);
                files
            }
            None => Vec::new(),
        };
        files.push(secrets_file(database_path));
        let kept = Kept {
            files,
            blobs: blobs.to_path_buf(),
            blobs_made: open(blobs, true)?.is_none(),
        };
        kept.database_opened()?;
        if !kept.blobs_made {
            secure(&kept.blobs, true, me)?;
        }
        Ok(kept)
    }

    pub fn database_opened(&self) -> Result<(), Failure> {
        let me = me();
        self.files
            .iter()
            .try_for_each(|file| secure(file, false, me))
    }

    pub fn blobs_opened(&self) -> Result<(), Failure> {
        if self.blobs_made {
            secure(&self.blobs, true, me())?;
        }
        Ok(())
    }
}

/// `None` when nothing is there; a link is refused, never followed.
fn open(path: &Path, folder: bool) -> Result<Option<File>, Failure> {
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK | if folder { libc::O_DIRECTORY } else { 0 };
    match OpenOptions::new().read(true).custom_flags(flags).open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(not_opened(path, &error)),
    }
}

fn open_at(folder: &File, name: &OsStr, path: &Path, is_folder: bool) -> Result<File, Failure> {
    let name = CString::new(name.as_bytes())
        .map_err(|_| refused(path, "has a name the server cannot open"))?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if is_folder { libc::O_DIRECTORY } else { 0 };
    use std::os::fd::AsRawFd;
    // SAFETY: the folder is open and the name is a live C string.
    let fd = unsafe { libc::openat(folder.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(not_opened(path, &std::io::Error::last_os_error()));
    }
    // SAFETY: `openat` returned a descriptor that nothing else owns.
    Ok(File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
}

fn not_opened(path: &Path, error: &std::io::Error) -> Failure {
    // macOS answers ENOTDIR, not ELOOP, for a link opened as a folder.
    let link = std::fs::symlink_metadata(path).is_ok_and(|found| found.is_symlink());
    match error.raw_os_error() {
        _ if link => refused(
            path,
            "is a symbolic link, and the server keeps its data only where it can make it \
             private. Name the file or folder the link points to instead.",
        ),
        Some(libc::ENOTDIR) => refused(path, "is not a folder"),
        Some(libc::ELOOP) => refused(path, "could not be opened: too many symbolic links"),
        _ => refused(path, format_args!("could not be opened: {error}")),
    }
}

fn read(file: &File, path: &Path) -> Result<Metadata, Failure> {
    file.metadata()
        .map_err(|error| refused(path, format_args!("could not be read: {error}")))
}

/// Takes group and other access and every access control list entry off what is the server's.
fn close(file: &File, found: &Metadata, path: &Path) -> Result<(), Failure> {
    let reach = marfa_acl::reach(file, me()).map_err(|error| unreadable_acl(path, &error))?;
    if reach != marfa_acl::Reach::default() {
        marfa_acl::clear(file).map_err(|error| {
            refused(
                path,
                format_args!("has an access control list the server could not remove: {error}"),
            )
        })?;
    }
    if found.mode() & OTHERS != 0 {
        file.set_permissions(Permissions::from_mode(found.mode() & OWNER))
            .map_err(|error| refused(path, format_args!("could not be made private: {error}")))?;
    }
    Ok(())
}

fn unreadable_acl(path: &Path, error: &std::io::Error) -> Failure {
    refused(
        path,
        format_args!("has an access control list that could not be read: {error}"),
    )
}

enum Exposure {
    Mode(u32),
    Acl,
    PassedOn,
}

fn exposure(file: &File, path: &Path) -> Result<Option<Exposure>, Failure> {
    let mode = read(file, path)?.mode();
    if mode & OTHERS != 0 {
        return Ok(Some(Exposure::Mode(mode & 0o7777)));
    }
    let reach = marfa_acl::reach(file, me()).map_err(|error| unreadable_acl(path, &error))?;
    Ok(if reach.passed_on {
        Some(Exposure::PassedOn)
    } else if reach.itself {
        Some(Exposure::Acl)
    } else {
        None
    })
}

fn exposed(path: &Path, why: &Exposure, ours: bool) -> Failure {
    let what = match why {
        Exposure::Mode(mode) => format!("is open to other accounts (mode {mode:04o})"),
        Exposure::Acl => "has an access control list that lets another account in".to_string(),
        Exposure::PassedOn => "passes access to another account on to what is made inside it, \
                               through its access control list"
            .to_string(),
    };
    let fix = match (why, ours) {
        (_, true) => "The server could not make it private: keep the data on a file system \
                      that keeps file modes and access control lists."
            .to_string(),
        (Exposure::Mode(_), false) => format!(
            "It belongs to another account: give it to the server's account with `chown`, or \
             run `chmod go-rwx {}`.",
            path.display()
        ),
        (Exposure::Acl, false) => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(false)
        ),
        (Exposure::PassedOn, false) => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(true)
        ),
    };
    refused(path, format_args!("{what}. {fix}"))
}

/// The folder files are made in may be another account's and open, but must not pass access on.
fn passes_nothing_on(folder: &Path, me: u32) -> Result<(), Failure> {
    let opened = match File::open(folder) {
        Ok(opened) => opened,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(refused(
                folder,
                format_args!("could not be opened: {error}"),
            ));
        }
    };
    let reach = marfa_acl::reach(&opened, me).map_err(|error| unreadable_acl(folder, &error))?;
    if reach.passed_on {
        return Err(refused(
            folder,
            format_args!(
                "passes access to another account on to the files the server makes in it, \
                 through its access control list. Remove those entries with {}, or keep the \
                 database in another folder.",
                marfa_acl::removal_command(true)
            ),
        ));
    }
    Ok(())
}

fn secure(path: &Path, folder: bool, me: u32) -> Result<(), Failure> {
    match open(path, folder)? {
        Some(file) => secure_opened(&file, path, folder, me),
        None => Ok(()),
    }
}

/// A folder of another account's may be open, as a mounted volume often is, as long as what
/// the server keeps inside is private.
fn secure_opened(file: &File, path: &Path, folder: bool, me: u32) -> Result<(), Failure> {
    let found = read(file, path)?;
    if !folder && !found.is_file() {
        return Err(refused(path, "is not a file"));
    }
    let ours = found.uid() == me;
    if ours {
        close(file, &found, path)?;
    }
    match exposure(file, path)? {
        None => Ok(()),
        Some(Exposure::Mode(_) | Exposure::Acl) if folder && !ours => inside(file, path, me),
        Some(why) => Err(exposed(path, &why, ours)),
    }
}

fn inside(folder: &File, path: &Path, me: u32) -> Result<(), Failure> {
    let entries = std::fs::read_dir(path)
        .map_err(|error| refused(path, format_args!("could not be listed: {error}")))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| refused(path, format_args!("could not be listed: {error}")))?;
        let kind = entry
            .file_type()
            .map_err(|error| refused(&entry.path(), format_args!("could not be read: {error}")))?;
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        let child = entry.path();
        let opened = open_at(folder, &entry.file_name(), &child, kind.is_dir())?;
        secure_opened(&opened, &child, kind.is_dir(), me)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use marfa_acl::testing::{Grant, let_another_account};

    use super::*;

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    fn chmod(path: &Path, mode: u32) {
        fs::set_permissions(path, Permissions::from_mode(mode)).unwrap();
    }

    fn reach(path: &Path) -> marfa_acl::Reach {
        marfa_acl::reach(&File::open(path).unwrap(), me()).unwrap()
    }

    #[test]
    fn what_is_the_servers_is_made_private_and_a_link_is_refused_unfollowed() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, file) = (dir.path().join("blobs"), dir.path().join("marfa.db"));
        fs::create_dir(&folder).unwrap();
        fs::write(&file, "").unwrap();
        chmod(&folder, 0o755);
        chmod(&file, 0o644);
        secure(&folder, true, me()).unwrap();
        secure(&file, false, me()).unwrap();
        assert_eq!((mode(&folder), mode(&file)), (0o700, 0o600));

        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        chmod(&outside, 0o755);
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let failure = secure(&link, true, me()).unwrap_err();
        assert!(failure.message.contains("symbolic link"), "{failure}");
        assert_eq!(mode(&outside), 0o755);
    }

    #[test]
    fn an_access_control_list_on_what_is_the_servers_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, file) = (dir.path().join("blobs"), dir.path().join("marfa.db"));
        fs::create_dir(&folder).unwrap();
        fs::write(&file, "").unwrap();
        chmod(&file, 0o640);
        if !let_another_account(&folder, Grant::Read) {
            eprintln!("skipped: this file system keeps no access control lists");
            return;
        }
        assert!(let_another_account(&folder, Grant::InheritReadToFiles));
        assert!(let_another_account(&file, Grant::ReadFile));
        assert!(reach(&folder).itself && reach(&folder).passed_on);
        assert!(reach(&file).itself);
        secure(&folder, true, me()).unwrap();
        secure(&file, false, me()).unwrap();
        assert_eq!(reach(&folder), marfa_acl::Reach::default());
        assert_eq!(reach(&file), marfa_acl::Reach::default());
        assert_eq!(mode(&file), 0o600);
    }

    #[test]
    fn a_database_folder_that_passes_access_on_refuses_the_start_and_is_left_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        chmod(&data, 0o755);
        let database = DatabasePath::File(data.join("marfa.db"));
        // The witness: an open folder that passes nothing on is kept as it is, and allowed.
        passes_nothing_on(&data, me()).unwrap();
        if !let_another_account(&data, Grant::InheritReadToFiles) {
            eprintln!("skipped: this file system keeps no access control lists");
            return;
        }
        let failure = passes_nothing_on(&data, me()).unwrap_err();
        assert!(failure.message.contains("passes access"), "{failure}");
        make_data_folder(&database).unwrap();
        assert!(reach(&data).passed_on);
        assert_eq!(mode(&data), 0o755);
    }

    #[test]
    fn a_database_folder_the_server_makes_is_private_and_takes_no_inherited_entry() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared");
        fs::create_dir(&shared).unwrap();
        let data = shared.join("data");
        let inherits = let_another_account(&shared, Grant::InheritRead)
            && let_another_account(&shared, Grant::InheritReadToFiles);
        make_data_folder(&DatabasePath::File(data.join("marfa.db"))).unwrap();
        assert_eq!(mode(&data), 0o700);
        assert_eq!(reach(&data), marfa_acl::Reach::default());
        if inherits {
            // The witness: a folder made there by another hand inherits the entries.
            let other = shared.join("other");
            fs::create_dir(&other).unwrap();
            assert_ne!(reach(&other), marfa_acl::Reach::default());
        }
    }

    #[test]
    fn inside_an_open_folder_of_another_account_only_its_own_files_are_changed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("blob");
        fs::write(&file, "").unwrap();
        chmod(&file, 0o644);
        chmod(dir.path(), 0o755);
        let opened = open(dir.path(), true).unwrap().unwrap();
        // As if the folder were another account's: its own mode is never changed.
        inside(&opened, dir.path(), me()).unwrap();
        assert_eq!((mode(dir.path()), mode(&file)), (0o755, 0o600));
    }
}
