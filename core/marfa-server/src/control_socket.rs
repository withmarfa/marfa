//! The private control socket's path: the folders above it, who holds it, and
//! what is left there.
//!
//! Only the server's own account may reach the socket. Every folder above it
//! is held to that before anything is made there, and the socket is bound
//! under a name of its own and made private before it appears at its path.

use std::ffi::{CString, OsString};
use std::fs::{File, Metadata, OpenOptions, TryLockError};
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};

use crate::failure::Failure;

const PRIVATE_FOLDER: u32 = 0o700;
const PRIVATE_FILE: u32 = 0o600;
/// `sun_path` holds 104 bytes on macOS and 108 on Linux, with a NUL at the end.
pub const MAX_PATH_BYTES: usize = 103;
const STICKY: u32 = 0o1000;
const OTHERS_WRITE: u32 = 0o022;

/// The right to serve at a path. A lock file beside the socket settles who
/// may look at what is there, and stays locked until the process has gone, so
/// a start cannot take the path from a server that is still closing.
pub struct Claim {
    path: PathBuf,
    lock: File,
    published: Option<(u64, u64)>,
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

/// A folder's standing, as its own entry reports it.
#[derive(Clone, Copy, Debug)]
struct Found {
    link: bool,
    folder: bool,
    owner: u32,
    mode: u32,
}

impl Found {
    fn of(found: &Metadata) -> Found {
        Found {
            link: found.file_type().is_symlink(),
            folder: found.is_dir(),
            owner: found.uid(),
            mode: found.mode(),
        }
    }
}

/// What keeps a folder on the way to the socket from being private, if
/// anything. `last` is the folder that holds the socket.
fn folder_fault(found: Found, me: u32, last: bool) -> Option<&'static str> {
    if found.link {
        return Some("is a symbolic link");
    }
    if !found.folder {
        return Some("is not a folder");
    }
    if found.owner != me && found.owner != 0 {
        return Some("belongs to another account");
    }
    let shared_tmp = found.owner == 0 && found.mode & STICKY != 0;
    if found.mode & OTHERS_WRITE != 0 && !shared_tmp {
        return Some("can be written by another account");
    }
    if last && (found.owner != me || found.mode & 0o777 != PRIVATE_FOLDER) {
        return Some("must belong to the server's account with mode 0700");
    }
    None
}

fn refused_folder(folder: &Path, why: &str) -> Failure {
    Failure::start(format!(
        "The control socket's folder {} {why}",
        folder.display()
    ))
}

/// Makes each missing folder above the socket private, and refuses one that
/// another account could change or reach into.
fn prepare_folders(path: &Path, me: u32) -> Result<(), Failure> {
    let Some(holder) = path.parent() else {
        return Ok(());
    };
    let mut folder = PathBuf::new();
    for part in holder.components() {
        folder.push(part);
        if part == Component::RootDir {
            continue;
        }
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
        if let Some(why) = folder_fault(Found::of(&found), me, folder == holder) {
            return Err(refused_folder(&folder, why));
        }
        refuse_acl(&folder, "folder")?;
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
    match UnixStream::connect(path) {
        Ok(_) => return Err(in_use(path)),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(unreadable(error)),
    }
    match std::fs::symlink_metadata(path) {
        Ok(now) if (now.dev(), now.ino()) == (found.dev(), found.ino()) => {
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(unreadable(error)),
            }
        }
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
        self.published = Some(published?);
        Ok(listener)
    }

    /// Removes the socket while it is still this server's, and keeps the lock
    /// until the process exits.
    pub fn release(self) {
        if let Some(identity) = self.published {
            match std::fs::symlink_metadata(&self.path) {
                Ok(now) if (now.dev(), now.ino()) == identity => {
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

/// Makes the socket at `bound` private and links it at `path`, answering
/// the socket's identity.
fn publish(bound: &Path, path: &Path) -> Result<(u64, u64), Failure> {
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
    Ok((found.dev(), found.ino()))
}

fn refuse_acl(path: &Path, what: &str) -> Result<(), Failure> {
    match grants_by_acl(path) {
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

fn c_path(path: &Path) -> std::io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))
}

/// Whether an entry of the path's ACL allows anything. Deny entries narrow
/// access, so they stand.
#[cfg(target_os = "macos")]
fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
    use std::ffi::{c_char, c_int, c_void};

    #[allow(non_camel_case_types)]
    type acl_t = *mut c_void;
    #[allow(non_camel_case_types)]
    type acl_entry_t = *mut c_void;
    const ACL_TYPE_EXTENDED: c_int = 0x100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ACL_NEXT_ENTRY: c_int = -1;
    const ACL_EXTENDED_ALLOW: c_int = 1;
    unsafe extern "C" {
        fn acl_get_link_np(path: *const c_char, kind: c_int) -> acl_t;
        fn acl_get_entry(acl: acl_t, entry_id: c_int, entry: *mut acl_entry_t) -> c_int;
        fn acl_get_tag_type(entry: acl_entry_t, tag: *mut c_int) -> c_int;
        fn acl_free(object: *mut c_void) -> c_int;
    }

    let name = c_path(path)?;
    // SAFETY: `name` is NUL-terminated and outlives the call. A non-null
    // answer is owned here and freed below, and each entry is read only while
    // it is held.
    unsafe {
        let acl = acl_get_link_np(name.as_ptr(), ACL_TYPE_EXTENDED);
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENOENT) => Ok(false),
                _ => Err(error),
            };
        }
        let mut grants = false;
        let mut entry: acl_entry_t = std::ptr::null_mut();
        let mut which = ACL_FIRST_ENTRY;
        while acl_get_entry(acl, which, &mut entry) == 0 {
            let mut tag: c_int = 0;
            if acl_get_tag_type(entry, &mut tag) == 0 && tag == ACL_EXTENDED_ALLOW {
                grants = true;
                break;
            }
            which = ACL_NEXT_ENTRY;
        }
        acl_free(acl);
        Ok(grants)
    }
}

/// Whether the path's POSIX ACL names an account or group beyond its owner,
/// or holds a default ACL for what is made inside it.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
    if read_xattr(path, c"system.posix_acl_default")?.is_some_and(|value| value.len() > 4) {
        return Ok(true);
    }
    Ok(read_xattr(path, c"system.posix_acl_access")?.is_some_and(|value| names_others(&value)))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_xattr(path: &Path, name: &std::ffi::CStr) -> std::io::Result<Option<Vec<u8>>> {
    let file = c_path(path)?;
    loop {
        // SAFETY: both names are NUL-terminated and outlive the calls, and
        // the buffer passed is as long as the size given with it.
        let size =
            unsafe { libc::lgetxattr(file.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENODATA | libc::ENOTSUP) => Ok(None),
                _ => Err(error),
            };
        }
        let mut value = vec![0u8; size.unsigned_abs()];
        let read = unsafe {
            libc::lgetxattr(
                file.as_ptr(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if read >= 0 {
            value.truncate(read.unsigned_abs());
            return Ok(Some(value));
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ERANGE) => continue,
            Some(libc::ENODATA | libc::ENOTSUP) => return Ok(None),
            _ => return Err(error),
        }
    }
}

/// Whether an ACL in the kernel's extended attribute form names a user or a
/// group: a four-byte version, then eight bytes for each entry, its tag first.
#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
fn names_others(value: &[u8]) -> bool {
    const NAMED_USER: u16 = 0x02;
    const NAMED_GROUP: u16 = 0x08;
    value.get(4..).unwrap_or_default().chunks(8).any(|entry| {
        let tag = u16::from_le_bytes([entry[0], *entry.get(1).unwrap_or(&0)]);
        tag == NAMED_USER || tag == NAMED_GROUP
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn grants_by_acl(_path: &Path) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        ErrorKind::Unsupported,
        "a private control socket needs macOS or Linux",
    ))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

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
    fn each_folder_rule_is_judged_by_owner_and_mode() {
        let me = 501;
        let folder = |owner, mode| Found {
            link: false,
            folder: true,
            owner,
            mode,
        };
        let link = Found {
            link: true,
            ..folder(me, 0o700)
        };
        let file = Found {
            folder: false,
            ..folder(me, 0o600)
        };
        assert_eq!(folder_fault(link, me, false), Some("is a symbolic link"));
        assert_eq!(folder_fault(file, me, false), Some("is not a folder"));
        assert_eq!(
            folder_fault(folder(502, 0o700), me, false),
            Some("belongs to another account")
        );
        for open in [0o770, 0o702, 0o777] {
            assert_eq!(
                folder_fault(folder(me, open), me, false),
                Some("can be written by another account"),
                "{open:o}"
            );
        }
        assert_eq!(
            folder_fault(folder(0, 0o777), me, false),
            Some("can be written by another account")
        );
        assert_eq!(folder_fault(folder(0, 0o1777), me, false), None);
        assert_eq!(folder_fault(folder(0, 0o755), me, false), None);
        assert_eq!(folder_fault(folder(me, 0o755), me, false), None);
        for last in [folder(me, 0o750), folder(me, 0o500), folder(0, 0o700)] {
            assert_eq!(
                folder_fault(last, me, true),
                Some("must belong to the server's account with mode 0700"),
                "{last:?}"
            );
        }
        assert_eq!(folder_fault(folder(me, 0o700), me, true), None);
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
        assert!(said.contains("belongs to another account"), "{said}");
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

    #[test]
    fn an_acl_naming_another_account_is_seen() {
        let entry = |tag: u16| {
            let mut bytes = tag.to_le_bytes().to_vec();
            bytes.extend_from_slice(&[7, 0, 0, 0, 0, 0]);
            bytes
        };
        let acl = |tags: &[u16]| {
            let mut bytes = 2u32.to_le_bytes().to_vec();
            for tag in tags {
                bytes.extend(entry(*tag));
            }
            bytes
        };
        assert!(!names_others(&acl(&[0x01, 0x04, 0x20])));
        assert!(names_others(&acl(&[0x01, 0x02, 0x04, 0x10, 0x20])));
        assert!(names_others(&acl(&[0x01, 0x04, 0x08, 0x10, 0x20])));
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
