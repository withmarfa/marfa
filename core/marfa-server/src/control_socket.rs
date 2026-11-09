//! Protects the control socket from access or replacement by other accounts.

use std::ffi::OsString;
use std::fs::{File, Metadata, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};

use crate::failure::Failure;

const PRIVATE_FOLDER: u32 = 0o700;
const PRIVATE_FILE: u32 = 0o600;
/// `sun_path` holds 104 bytes on macOS and 108 on Linux, with a NUL at the end.
pub const MAX_PATH_BYTES: usize = 103;

/// The right to serve at a path. A lock file beside the socket settles who
/// may look at what is there, and stays locked until the process has gone, so
/// a start cannot take the path from a server that is still closing.
pub struct Claim {
    path: PathBuf,
    lock: File,
    published: Option<Identity>,
}

fn in_use(path: &Path) -> Failure {
    Failure::start(format!(
        "Control socket path is already in use: {}",
        path.display()
    ))
}

fn me() -> u32 {
    // SAFETY: `geteuid` takes nothing and cannot fail.
    unsafe { libc::geteuid() }
}

/// Refuses a path that is not absolute and normalized, or that the platform
/// cannot bind.
pub fn check_path(path: &Path) -> Result<(), Failure> {
    let normal: PathBuf = path.components().collect();
    let plain = path.is_absolute()
        && normal.as_os_str() == path.as_os_str()
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
        && path.file_name().is_some()
        && path.as_os_str().len() <= MAX_PATH_BYTES;
    if plain {
        return Ok(());
    }
    Err(Failure::start(format!(
        "MARFA_CONTROL_SOCKET must be a normalized absolute path of at most \
         {MAX_PATH_BYTES} bytes: {}",
        path.display()
    )))
}

/// The socket's path when none is named: `control/marfa.sock` in `folder`,
/// made absolute from the working folder and normalized.
pub fn default_path(folder: &Path) -> PathBuf {
    let joined = folder.join("control").join("marfa.sock");
    let absolute = std::path::absolute(&joined).unwrap_or(joined);
    let mut normal = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normal.pop();
            }
            Component::CurDir => {}
            other => normal.push(other),
        }
    }
    normal
}

fn refused_folder(folder: &Path, why: &str) -> Failure {
    Failure::start(format!(
        "The control socket's folder {} {why}",
        folder.display()
    ))
}

/// Ancestors must prevent replacement; the socket's folder must also prevent access.
fn prepare_folders(path: &Path, me: u32) -> Result<(), Failure> {
    let Some(holder) = path.parent() else {
        return Ok(());
    };
    let Some(folders) = marfa_acl::folders_from_root(holder) else {
        return Err(refused_folder(holder, "is not a normalized absolute path"));
    };
    for folder in folders {
        match std::fs::DirBuilder::new()
            .mode(PRIVATE_FOLDER)
            .create(&folder)
        {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(refused_folder(
                    &folder,
                    &format!("could not be created: {error}"),
                ));
            }
        }
        let found = std::fs::symlink_metadata(&folder)
            .map_err(|error| refused_folder(&folder, &format!("could not be read: {error}")))?;
        match marfa_acl::exposure(&folder, &found, me) {
            Ok(None) => {}
            Ok(Some(why)) => return Err(refused_folder(&folder, &why.to_string())),
            Err(error) => {
                return Err(refused_folder(
                    &folder,
                    &format!("has an access control list that could not be read: {error}"),
                ));
            }
        }
        if folder == holder {
            if found.uid() != me || found.mode() & 0o777 != PRIVATE_FOLDER {
                return Err(refused_folder(
                    &folder,
                    "must belong to the server's account with mode 0700",
                ));
            }
            refuse_acl(&folder, "folder")?;
        }
    }
    Ok(())
}

fn refused_lock(lock: &Path, why: impl std::fmt::Display) -> Failure {
    Failure::start(format!(
        "The control socket's lock {} {why}",
        lock.display()
    ))
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

fn open_lock(lock: &Path) -> Result<File, Failure> {
    let made = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(lock);
    match made {
        Ok(file) => {
            file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE))
                .map_err(|error| {
                    refused_lock(lock, format!("could not be made private: {error}"))
                })?;
            Ok(file)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(lock)
            .map_err(|error| refused_lock(lock, format!("could not be opened: {error}"))),
        Err(error) => Err(refused_lock(lock, format!("could not be opened: {error}"))),
    }
}

fn take_lock(path: &Path, me: u32) -> Result<File, Failure> {
    let lock = lock_path(path);
    let file = open_lock(&lock)?;
    let held = file
        .metadata()
        .map_err(|error| refused_lock(&lock, format!("could not be read: {error}")))?;
    if !held.is_file()
        || held.uid() != me
        || held.mode() & 0o777 != PRIVATE_FILE
        || held.nlink() != 1
    {
        return Err(refused_lock(
            &lock,
            "must be a file of the server's account alone, with mode 0600 and one link",
        ));
    }
    refuse_acl(&lock, "lock")?;
    let named = std::fs::symlink_metadata(&lock)
        .map_err(|error| refused_lock(&lock, format!("could not be read: {error}")))?;
    if (named.dev(), named.ino()) != (held.dev(), held.ino()) {
        return Err(refused_lock(&lock, "changed while it was opened"));
    }
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(in_use(path)),
        Err(TryLockError::Error(error)) => {
            Err(refused_lock(&lock, format!("could not be taken: {error}")))
        }
    }
}

const STALE_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

fn clear_stale(path: &Path) -> Result<(), Failure> {
    let unreadable = |error: std::io::Error| {
        Failure::start(format!("{} could not be read: {error}", path.display()))
    };
    let exists = || Failure::start(format!("Control socket already exists: {}", path.display()));
    let found = match std::fs::symlink_metadata(path) {
        Ok(found) => found,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(unreadable(error)),
    };
    if !found.file_type().is_socket() {
        return Err(exists());
    }
    let (sent, answer) = std::sync::mpsc::channel();
    let target = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = sent.send(UnixStream::connect(target));
    });
    // A listener that never accepts is a socket in use, not a stale one.
    match answer
        .recv_timeout(STALE_CONNECT_TIMEOUT)
        .unwrap_or_else(|_| Err(ErrorKind::TimedOut.into()))
    {
        Ok(_) => return Err(in_use(path)),
        Err(error) if error.kind() == ErrorKind::TimedOut => return Err(in_use(path)),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(unreadable(error)),
    }
    match std::fs::symlink_metadata(path) {
        Ok(now) if identity(&now) == identity(&found) => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(unreadable(error)),
        },
        Ok(_) => Err(exists()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(unreadable(error)),
    }
}

fn bound_name(path: &Path) -> Result<PathBuf, Failure> {
    let mut random = [0u8; 6];
    getrandom::fill(&mut random)
        .map_err(|error| Failure::start(format!("No random name for the socket: {error}")))?;
    let mut name = OsString::from(".s-");
    name.push(hex::encode(random));
    let bound = path.with_file_name(name);
    if bound.as_os_str().len() > MAX_PATH_BYTES {
        return Err(Failure::start(format!(
            "The control socket's folder is too long a path to bind in: {}",
            path.display()
        )));
    }
    Ok(bound)
}

impl Claim {
    /// Takes the path, replacing a socket no process is listening on and
    /// leaving alone anything else.
    pub fn take(path: &Path) -> Result<Claim, Failure> {
        check_path(path)?;
        let me = me();
        prepare_folders(path, me)?;
        let lock = take_lock(path, me)?;
        clear_stale(path)?;
        Ok(Claim {
            path: path.to_path_buf(),
            lock,
            published: None,
        })
    }

    /// Binds the socket under a name of its own, makes it readable by the
    /// server's own account alone, and only then links it at its path.
    pub fn bind(&mut self) -> Result<UnixListener, Failure> {
        let bound = bound_name(&self.path)?;
        let refused = |error: std::io::Error| {
            Failure::start(format!(
                "The control socket {} could not be bound: {error}",
                self.path.display()
            ))
        };
        let listener = UnixListener::bind(&bound).map_err(refused)?;
        let published = listener
            .set_nonblocking(true)
            .map_err(refused)
            .and_then(|()| publish(&bound, &self.path));
        let _ = std::fs::remove_file(&bound);
        let (dev, ino, _, _) = published?;
        let now = std::fs::symlink_metadata(&self.path).map_err(refused)?;
        if (now.dev(), now.ino()) != (dev, ino) {
            return Err(Failure::start(format!(
                "The control socket {} changed while it was published",
                self.path.display()
            )));
        }
        self.published = Some(identity(&now));
        Ok(listener)
    }

    /// Removes the socket while it is still this server's, and keeps the lock
    /// until the process exits.
    pub fn release(self) {
        if let Some(published) = self.published {
            match std::fs::symlink_metadata(&self.path) {
                Ok(now) if identity(&now) == published => {
                    if let Err(error) = std::fs::remove_file(&self.path) {
                        tracing::warn!(error = %error, "The control socket was not removed");
                    }
                }
                _ => {}
            }
        }
        std::mem::forget(self.lock);
    }
}

/// Which file a path names. An inode number alone is reused at once on some
/// file systems, so the change time is part of it.
type Identity = (u64, u64, i64, i64);

fn identity(found: &Metadata) -> Identity {
    (found.dev(), found.ino(), found.ctime(), found.ctime_nsec())
}

/// Makes the socket at `bound` private and links it at `path`, answering
/// the socket's identity before the link.
fn publish(bound: &Path, path: &Path) -> Result<Identity, Failure> {
    let refused = |error: std::io::Error| {
        Failure::start(format!(
            "The control socket {} could not be published: {error}",
            path.display()
        ))
    };
    std::fs::set_permissions(bound, std::fs::Permissions::from_mode(PRIVATE_FILE))
        .map_err(refused)?;
    refuse_acl(bound, "socket")?;
    let found = std::fs::symlink_metadata(bound).map_err(refused)?;
    if !found.file_type().is_socket() || found.mode() & 0o777 != PRIVATE_FILE {
        return Err(Failure::start(format!(
            "The control socket {} could not be made private",
            path.display()
        )));
    }
    std::fs::hard_link(bound, path).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            Failure::start(format!("Control socket already exists: {}", path.display()))
        } else {
            refused(error)
        }
    })?;
    Ok(identity(&found))
}

fn refuse_acl(path: &Path, what: &str) -> Result<(), Failure> {
    match marfa_acl::grants_by_acl(path) {
        Ok(false) => Ok(()),
        Ok(true) => Err(Failure::start(format!(
            "The control socket's {what} {} has an access control list that grants access",
            path.display()
        ))),
        Err(error) => Err(Failure::start(format!(
            "The access control list of the control socket's {what} {} could not be read: {error}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use marfa_acl::testing::{Grant, let_another_account};
    use tempfile::TempDir;

    use super::*;

    /// A folder whose own path has no symbolic link in it, as macOS's
    /// temporary folder does.
    fn private_root() -> (TempDir, PathBuf) {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let dir = TempDir::new_in(root).unwrap();
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    fn refusal(path: &Path) -> String {
        match Claim::take(path) {
            Ok(_) => panic!("{} was taken", path.display()),
            Err(failure) => failure.message,
        }
    }

    fn set_mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn a_path_must_be_absolute_normalized_and_short_enough_to_bind() {
        let long = format!("/{}", "a".repeat(MAX_PATH_BYTES));
        for wrong in [
            "control/marfa.sock",
            "./marfa.sock",
            "/run/marfa/../marfa.sock",
            "/run/./marfa.sock",
            "/run//marfa.sock",
            "/run/marfa/",
            "/",
            long.as_str(),
        ] {
            assert!(check_path(Path::new(wrong)).is_err(), "{wrong}");
        }
        let longest = format!("/{}", "a".repeat(MAX_PATH_BYTES - 1));
        for right in ["/run/marfa/marfa.sock", longest.as_str()] {
            assert!(check_path(Path::new(right)).is_ok(), "{right}");
        }
    }

    #[test]
    fn the_default_path_is_absolute_and_normalized() {
        let path = default_path(Path::new("./data/../state"));
        assert!(check_path(&path).is_ok() || path.as_os_str().len() > MAX_PATH_BYTES);
        assert!(
            path.ends_with("state/control/marfa.sock"),
            "{}",
            path.display()
        );
        assert_eq!(
            default_path(Path::new("/srv/marfa/../data")),
            Path::new("/srv/data/control/marfa.sock")
        );
    }

    #[test]
    fn missing_folders_are_made_private_and_the_socket_is_published_private() {
        let (_dir, root) = private_root();
        let path = root.join("a").join("b").join("marfa.sock");
        let mut claim = Claim::take(&path).unwrap();
        for folder in [root.join("a"), root.join("a").join("b")] {
            let mode = std::fs::metadata(&folder).unwrap().mode();
            assert_eq!(mode & 0o777, 0o700, "{}", folder.display());
        }
        let _listener = claim.bind().unwrap();
        let found = std::fs::symlink_metadata(&path).unwrap();
        assert!(found.file_type().is_socket());
        assert_eq!(found.mode() & 0o777, 0o600);
        assert_eq!(found.nlink(), 1);
        UnixStream::connect(&path).unwrap();
        let names: Vec<_> = std::fs::read_dir(root.join("a").join("b"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        claim.release();
        assert!(!path.exists());
    }

    #[test]
    fn a_symbolic_link_on_the_way_is_refused_and_nothing_is_made_past_it() {
        let (_dir, root) = private_root();
        let real = root.join("real");
        std::fs::create_dir(&real).unwrap();
        set_mode(&real, 0o700);
        symlink(&real, root.join("linked")).unwrap();
        let said = refusal(&root.join("linked").join("inner").join("marfa.sock"));
        assert!(said.contains("is a symbolic link"), "{said}");
        assert!(said.contains("linked"), "{said}");
        assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);

        symlink(&real, root.join("last")).unwrap();
        let said = refusal(&root.join("last").join("marfa.sock"));
        assert!(said.contains("is a symbolic link"), "{said}");
    }

    #[test]
    fn a_folder_another_account_can_write_is_refused_not_repaired() {
        let (_dir, root) = private_root();
        let open = root.join("open");
        std::fs::create_dir(&open).unwrap();
        set_mode(&open, 0o770);
        let said = refusal(&open.join("inner").join("marfa.sock"));
        assert!(said.contains("can be written by another account"), "{said}");
        assert!(!open.join("inner").exists());
        assert_eq!(std::fs::metadata(&open).unwrap().mode() & 0o777, 0o770);
    }

    #[test]
    fn the_socket_folder_must_have_mode_0700() {
        let (_dir, root) = private_root();
        let folder = root.join("control");
        std::fs::create_dir(&folder).unwrap();
        set_mode(&folder, 0o750);
        let said = refusal(&folder.join("marfa.sock"));
        assert!(said.contains("mode 0700"), "{said}");
        assert!(said.contains(&folder.display().to_string()), "{said}");
        assert!(!folder.join("marfa.sock.lock").exists());
        set_mode(&folder, 0o700);
        Claim::take(&folder.join("marfa.sock")).unwrap();
    }

    #[test]
    fn a_folder_of_another_account_is_refused() {
        let (_dir, root) = private_root();
        let folder = root.join("control");
        std::fs::create_dir(&folder).unwrap();
        set_mode(&folder, 0o700);
        let said = prepare_folders(&folder.join("marfa.sock"), me() + 1)
            .unwrap_err()
            .message;
        // Root's folders are trusted, so as root only the socket's folder is another's.
        let why = if me() == 0 {
            "must belong to the server's account"
        } else {
            "belongs to another account"
        };
        assert!(said.contains(why), "{said}");
    }

    #[test]
    fn a_lock_that_is_a_link_or_shared_is_refused_and_left_alone() {
        let (_dir, root) = private_root();
        let path = root.join("marfa.sock");
        set_mode(&root, 0o700);
        let target = root.join("target");
        std::fs::write(&target, "kept").unwrap();
        symlink(&target, lock_path(&path)).unwrap();
        let said = refusal(&path);
        assert!(said.contains("lock"), "{said}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept");
        std::fs::remove_file(lock_path(&path)).unwrap();

        set_mode(&target, PRIVATE_FILE);
        std::fs::hard_link(&target, lock_path(&path)).unwrap();
        let said = refusal(&path);
        assert!(said.contains("one link"), "{said}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept");
        std::fs::remove_file(lock_path(&path)).unwrap();

        std::fs::write(lock_path(&path), "").unwrap();
        set_mode(&lock_path(&path), 0o644);
        let said = refusal(&path);
        assert!(said.contains("mode 0600"), "{said}");
    }

    #[test]
    fn a_second_claim_is_refused_while_the_first_holds_the_path() {
        let (_dir, root) = private_root();
        set_mode(&root, 0o700);
        let path = root.join("marfa.sock");
        let mut first = Claim::take(&path).unwrap();
        let _listener = first.bind().unwrap();
        assert!(refusal(&path).contains("already in use"));
        UnixStream::connect(&path).unwrap();
    }

    #[test]
    fn a_dead_socket_is_replaced_and_anything_else_is_left_alone() {
        let (_dir, root) = private_root();
        set_mode(&root, 0o700);
        let path = root.join("marfa.sock");
        drop(UnixListener::bind(&path).unwrap());
        let mut claim = Claim::take(&path).unwrap();
        let _listener = claim.bind().unwrap();
        UnixStream::connect(&path).unwrap();
        claim.release();

        let other = root.join("other.sock");
        std::fs::write(&other, "kept").unwrap();
        assert!(refusal(&other).contains("already exists"));
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "kept");
    }

    #[test]
    fn a_release_leaves_a_socket_that_replaced_its_own() {
        let (_dir, root) = private_root();
        set_mode(&root, 0o700);
        let path = root.join("marfa.sock");
        let mut claim = Claim::take(&path).unwrap();
        drop(claim.bind().unwrap());
        std::fs::remove_file(&path).unwrap();
        let _other = UnixListener::bind(&path).unwrap();
        claim.release();
        UnixStream::connect(&path).unwrap();
    }

    /// Returns `None` if the test ACL cannot be set.
    fn granted(root: &Path, name: &str, grant: Grant) -> Option<PathBuf> {
        let folder = root.join(name);
        std::fs::create_dir(&folder).unwrap();
        set_mode(&folder, 0o755);
        if let_another_account(&folder, grant) {
            Some(folder)
        } else {
            eprintln!("skipped: this file system keeps no ACLs");
            None
        }
    }

    #[test]
    fn a_folder_above_whose_acl_lets_another_account_only_read_is_accepted() {
        let (_dir, root) = private_root();
        let Some(above) = granted(&root, "above", Grant::Read) else {
            return;
        };
        let mut claim = Claim::take(&above.join("control").join("marfa.sock")).unwrap();
        let _listener = claim.bind().unwrap();

        let inherits = root.join("inherits");
        std::fs::create_dir(&inherits).unwrap();
        set_mode(&inherits, 0o755);
        std::fs::create_dir(inherits.join("control")).unwrap();
        set_mode(&inherits.join("control"), 0o700);
        assert!(let_another_account(&inherits, Grant::InheritRead));
        Claim::take(&inherits.join("control").join("marfa.sock")).unwrap();
        // A socket folder made below it inherits the read, which its own rule refuses.
        let said = refusal(&inherits.join("fresh").join("marfa.sock"));
        assert!(said.contains("access control list"), "{said}");
        assert!(
            said.contains(&inherits.join("fresh").display().to_string()),
            "{said}"
        );
    }

    #[test]
    fn a_folder_above_whose_acl_lets_another_account_write_is_refused_by_name() {
        let (_dir, root) = private_root();
        for grant in [Grant::Write, Grant::InheritWrite] {
            let Some(above) = granted(&root, &format!("{grant:?}"), grant) else {
                return;
            };
            let said = refusal(&above.join("control").join("marfa.sock"));
            assert!(
                said.contains(&format!("folder {} ", above.display())),
                "{grant:?}: {said}"
            );
            assert!(!above.join("control").exists(), "{grant:?}");
        }
    }

    #[test]
    fn the_socket_folder_whose_acl_lets_another_account_read_is_refused() {
        let (_dir, root) = private_root();
        let folder = root.join("control");
        std::fs::create_dir(&folder).unwrap();
        set_mode(&folder, 0o700);
        Claim::take(&folder.join("marfa.sock")).unwrap();
        if !let_another_account(&folder, Grant::Read) {
            eprintln!("skipped: this file system keeps no ACLs");
            return;
        }
        assert_eq!(std::fs::metadata(&folder).unwrap().mode() & 0o777, 0o700);
        let said = refusal(&folder.join("marfa.sock"));
        assert!(
            said.contains("access control list that grants access"),
            "{said}"
        );
    }

    /// Puts back the mode of `/` and removes its ACLs.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    struct RootRestored(u32);

    #[cfg(any(target_os = "linux", target_os = "android"))]
    impl Drop for RootRestored {
        fn drop(&mut self) {
            for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
                // SAFETY: both names are live C strings.
                unsafe { libc::removexattr(c"/".as_ptr(), name.as_ptr()) };
            }
            set_mode(Path::new("/"), self.0);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    #[ignore = "sets ACLs on /: run it alone, as root, in a throwaway Linux container, with MARFA_TEST_CHANGE_ROOT=1"]
    fn a_root_folder_whose_acl_lets_another_account_write_is_refused() {
        if me() != 0 || std::env::var_os("MARFA_TEST_CHANGE_ROOT").is_none_or(|set| set != "1") {
            eprintln!("skipped: it changes /, so it needs root and MARFA_TEST_CHANGE_ROOT=1");
            return;
        }
        let (_dir, root) = private_root();
        let path = root.join("control").join("marfa.sock");
        drop(Claim::take(&path).unwrap());
        let restored = RootRestored(std::fs::metadata("/").unwrap().mode() & 0o7777);
        for (grant, why) in [
            (Grant::InheritWrite, "access control list"),
            (Grant::Write, "can be written by another account"),
        ] {
            assert!(let_another_account(Path::new("/"), grant), "{grant:?}");
            let said = refusal(&path);
            assert!(said.contains("folder / "), "{grant:?}: {said}");
            assert!(said.contains(why), "{grant:?}: {said}");
            drop(RootRestored(restored.0));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_whose_acl_allows_another_account_is_refused() {
        let (_dir, root) = private_root();
        let folder = root.join("control");
        std::fs::create_dir(&folder).unwrap();
        set_mode(&folder, 0o700);
        let deny = std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone deny delete"])
            .arg(&folder)
            .status()
            .unwrap();
        assert!(deny.success());
        Claim::take(&folder.join("marfa.sock")).unwrap();
        let allow = std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone allow list,search"])
            .arg(&folder)
            .status()
            .unwrap();
        assert!(allow.success());
        let said = refusal(&folder.join("marfa.sock"));
        assert!(said.contains("access control list"), "{said}");
    }
}
