use std::ffi::CString;
use std::fs::Metadata;
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

fn c_path(path: &Path) -> std::io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))
}

/// What lets an account other than the trusted one or root replace what a
/// folder holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exposure {
    Link,
    NotFolder,
    Owner,
    Mode,
    Acl,
}

impl std::fmt::Display for Exposure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Exposure::Link => "is a symbolic link",
            Exposure::NotFolder => "is not a folder",
            Exposure::Owner => "belongs to another account",
            Exposure::Mode => "can be written by another account",
            Exposure::Acl => {
                "has an access control list that lets another account change what it holds"
            }
        })
    }
}

/// What an open file's or folder's access control list gives accounts other than its own.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reach {
    /// Reading, writing or entering the file or folder itself.
    pub itself: bool,
    /// Access passed on to what is made inside the folder.
    pub passed_on: bool,
}

/// The command a person runs to remove the entries behind a [`Reach`].
pub fn removal_command(passed_on: bool) -> &'static str {
    if cfg!(target_os = "macos") {
        "`chmod -N`"
    } else if passed_on {
        "`setfacl -k`"
    } else {
        "`setfacl -b`"
    }
}

/// `/` and each folder below it, down to `path` itself: the folders a check
/// of what `path` holds walks. `None` unless `path` is absolute and plain.
pub fn folders_from_root(path: &Path) -> Option<Vec<PathBuf>> {
    let mut parts = path.components();
    if parts.next() != Some(Component::RootDir) {
        return None;
    }
    let mut folder = PathBuf::from("/");
    let mut folders = vec![folder.clone()];
    for part in parts {
        let Component::Normal(name) = part else {
            return None;
        };
        folder.push(name);
        folders.push(folder.clone());
    }
    Some(folders)
}

/// Judges one folder of [`folders_from_root`] by its own entry `found`, `/`
/// included: `None` when only `trusted` or root can replace what it holds.
pub fn exposure(
    folder: &Path,
    found: &Metadata,
    trusted: u32,
) -> std::io::Result<Option<Exposure>> {
    let standing = by_mode(
        found.file_type().is_symlink(),
        found.is_dir(),
        found.uid(),
        found.mode(),
        trusted,
    );
    if standing.is_some() {
        return Ok(standing);
    }
    Ok(others_may_write(folder, trusted)?.then_some(Exposure::Acl))
}

// Root's sticky folders, such as `/tmp`, let nobody replace what is not theirs.
fn by_mode(link: bool, folder: bool, owner: u32, mode: u32, trusted: u32) -> Option<Exposure> {
    const STICKY: u32 = 0o1000;
    const GROUP_OR_OTHERS_WRITE: u32 = 0o022;
    if link {
        Some(Exposure::Link)
    } else if !folder {
        Some(Exposure::NotFolder)
    } else if owner != trusted && owner != 0 {
        Some(Exposure::Owner)
    } else if mode & GROUP_OR_OTHERS_WRITE != 0 && !(owner == 0 && mode & STICKY != 0) {
        Some(Exposure::Mode)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use std::ffi::{c_char, c_int, c_void};

    #[allow(non_camel_case_types)]
    type acl_t = *mut c_void;
    #[allow(non_camel_case_types)]
    pub type acl_entry_t = *mut c_void;
    const ACL_TYPE_EXTENDED: c_int = 0x100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ACL_NEXT_ENTRY: c_int = -1;
    const ACL_EXTENDED_ALLOW: c_int = 1;
    const ID_TYPE_UID: c_int = 0;
    const ACL_ENTRY_FILE_INHERIT: c_int = 1 << 5;
    const ACL_ENTRY_DIRECTORY_INHERIT: c_int = 1 << 6;
    const ACL_ENTRY_ONLY_INHERIT: c_int = 1 << 8;

    // Darwin's mutation rights, as defined by `sys/acl.h`.
    pub const WRITE_RIGHTS: u64 =
        (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 12) | (1 << 13);
    /// Reading the data, listing a folder, or running or entering it, as well as any write.
    pub const REACH_RIGHTS: u64 = (1 << 1) | (1 << 3) | WRITE_RIGHTS;

    /// Where an allow entry applies.
    #[derive(Clone, Copy)]
    pub struct Applies {
        pub itself: bool,
        pub passed_on: bool,
    }

    unsafe extern "C" {
        fn acl_get_link_np(path: *const c_char, kind: c_int) -> acl_t;
        fn acl_get_fd_np(fd: c_int, kind: c_int) -> acl_t;
        fn acl_get_entry(acl: acl_t, entry_id: c_int, entry: *mut acl_entry_t) -> c_int;
        fn acl_get_tag_type(entry: acl_entry_t, tag: *mut c_int) -> c_int;
        fn acl_get_permset_mask_np(entry: acl_entry_t, mask: *mut u64) -> c_int;
        fn acl_get_qualifier(entry: acl_entry_t) -> *mut c_void;
        fn acl_free(object: *mut c_void) -> c_int;
        fn acl_init(count: c_int) -> acl_t;
        fn acl_set_fd_np(fd: c_int, acl: acl_t, kind: c_int) -> c_int;
        fn acl_get_flagset_np(object: *mut c_void, flagset: *mut *mut c_void) -> c_int;
        fn acl_get_flag_np(flagset: *mut c_void, flag: c_int) -> c_int;
        fn mbr_uuid_to_id(uuid: *const u8, id: *mut libc::id_t, id_type: *mut c_int) -> c_int;
    }

    /// An ACL or a qualifier, freed when dropped.
    struct Freed(*mut c_void);

    impl Drop for Freed {
        fn drop(&mut self) {
            // SAFETY: the pointer came from an `acl_get_*` call that allocates.
            unsafe { acl_free(self.0) };
        }
    }

    pub struct Acl(Freed);

    impl Acl {
        /// `None` when the path has no extended ACL.
        pub fn of_link(path: &std::ffi::CStr) -> std::io::Result<Option<Acl>> {
            // SAFETY: `path` is a live C string.
            let acl = unsafe { acl_get_link_np(path.as_ptr(), ACL_TYPE_EXTENDED) };
            Self::taken(acl, &[libc::ENOENT])
        }

        /// `None` when the file has no extended ACL or its file system keeps none.
        pub fn of_fd(fd: c_int) -> std::io::Result<Option<Acl>> {
            // SAFETY: the caller keeps the descriptor open for the call.
            let acl = unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) };
            Self::taken(acl, &[libc::ENOENT, libc::EOPNOTSUPP])
        }

        fn taken(acl: acl_t, absent: &[c_int]) -> std::io::Result<Option<Acl>> {
            if !acl.is_null() {
                return Ok(Some(Acl(Freed(acl))));
            }
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(code) if absent.contains(&code) => Ok(None),
                _ => Err(error),
            }
        }

        /// Deny entries never count as grants.
        pub fn any_allow(
            &self,
            counts: impl Fn(acl_entry_t, u64) -> bool,
        ) -> std::io::Result<bool> {
            let mut found = false;
            self.each_allow(|entry, rights, _| found |= counts(entry, rights))?;
            Ok(found)
        }

        pub fn each_allow(
            &self,
            mut visit: impl FnMut(acl_entry_t, u64, Applies),
        ) -> std::io::Result<()> {
            let mut entry: acl_entry_t = std::ptr::null_mut();
            let mut which = ACL_FIRST_ENTRY;
            // SAFETY: the ACL is live and `entry` is written before it is read.
            while unsafe { acl_get_entry(self.0.0, which, &mut entry) } == 0 {
                which = ACL_NEXT_ENTRY;
                let mut tag = 0;
                let mut rights = 0u64;
                let mut flags: *mut c_void = std::ptr::null_mut();
                // SAFETY: `entry` belongs to the ACL, which outlives it and its flag set.
                unsafe {
                    if acl_get_tag_type(entry, &mut tag) != 0
                        || acl_get_permset_mask_np(entry, &mut rights) != 0
                        || acl_get_flagset_np(entry, &mut flags) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if tag == ACL_EXTENDED_ALLOW {
                    // SAFETY: the flag set belongs to `entry`, which the ACL outlives.
                    let flag = |flag| unsafe { acl_get_flag_np(flags, flag) == 1 };
                    let applies = Applies {
                        itself: !flag(ACL_ENTRY_ONLY_INHERIT),
                        passed_on: flag(ACL_ENTRY_FILE_INHERIT)
                            || flag(ACL_ENTRY_DIRECTORY_INHERIT),
                    };
                    visit(entry, rights, applies);
                }
            }
            Ok(())
        }
    }

    /// Leaves the file with no extended entries.
    pub fn clear_fd(fd: c_int) -> std::io::Result<()> {
        // SAFETY: `acl_init` allocates an empty ACL, freed when `empty` drops.
        let acl = unsafe { acl_init(0) };
        if acl.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let empty = Freed(acl);
        // SAFETY: the caller keeps the descriptor open, and the ACL is live.
        if unsafe { acl_set_fd_np(fd, empty.0, ACL_TYPE_EXTENDED) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// Groups and unresolved names are not trusted as the user `uid`.
    pub fn names_user(entry: acl_entry_t, uid: u32) -> bool {
        // SAFETY: an extended entry's qualifier is a 16-byte UUID.
        let qualifier = unsafe { acl_get_qualifier(entry) };
        if qualifier.is_null() {
            return false;
        }
        let qualifier = Freed(qualifier);
        let mut id: libc::id_t = 0;
        let mut kind = -1;
        // SAFETY: the qualifier holds 16 bytes and both outputs are valid.
        let resolved = unsafe { mbr_uuid_to_id(qualifier.0 as *const u8, &mut id, &mut kind) };
        resolved == 0 && kind == ID_TYPE_UID && id == uid
    }
}

/// Whether the path's ACL grants anyone anything: any allow entry counts.
#[cfg(target_os = "macos")]
pub fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
    match darwin::Acl::of_link(&c_path(path)?)? {
        Some(acl) => acl.any_allow(|_, _| true),
        None => Ok(false),
    }
}

/// Counts other accounts' mutation rights, including inherit-only entries.
#[cfg(target_os = "macos")]
pub fn others_may_write(path: &Path, own: u32) -> std::io::Result<bool> {
    match darwin::Acl::of_link(&c_path(path)?)? {
        Some(acl) => acl.any_allow(|entry, rights| writes_for_others(entry, rights, own)),
        None => Ok(false),
    }
}

/// [`others_may_write`] for an open file; macOS mode bits omit ACL grants.
#[cfg(target_os = "macos")]
pub fn others_may_write_file(file: &impl std::os::fd::AsRawFd, own: u32) -> std::io::Result<bool> {
    match darwin::Acl::of_fd(file.as_raw_fd())? {
        Some(acl) => acl.any_allow(|entry, rights| writes_for_others(entry, rights, own)),
        None => Ok(false),
    }
}

#[cfg(target_os = "macos")]
fn writes_for_others(entry: darwin::acl_entry_t, rights: u64, own: u32) -> bool {
    rights & darwin::WRITE_RIGHTS != 0 && !darwin::names_user(entry, own)
}

/// Group, `everyone` and deny entries aside, an entry for the user `own` reaches nobody else.
#[cfg(target_os = "macos")]
pub fn reach(file: &impl std::os::fd::AsRawFd, own: u32) -> std::io::Result<Reach> {
    let mut reach = Reach::default();
    if let Some(acl) = darwin::Acl::of_fd(file.as_raw_fd())? {
        acl.each_allow(|entry, rights, applies| {
            if rights & darwin::REACH_RIGHTS != 0 && !darwin::names_user(entry, own) {
                reach.itself |= applies.itself;
                reach.passed_on |= applies.passed_on;
            }
        })?;
    }
    Ok(reach)
}

/// Removes every entry of an open file's or folder's access control list; its mode stays.
#[cfg(target_os = "macos")]
pub fn clear(file: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    darwin::clear_fd(file.as_raw_fd())
}

/// Counts named users, named groups and default ACLs, regardless of the mask.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
    if read_xattr(path, DEFAULT)?.is_some_and(|value| value.len() > 4) {
        return Ok(true);
    }
    Ok(read_xattr(path, ACCESS)?.is_some_and(|value| posix::names_others(&value)))
}

/// Counts other accounts' effective write grants, including default ACLs.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn others_may_write(path: &Path, own: u32) -> std::io::Result<bool> {
    let access = read_xattr(path, ACCESS)?;
    let default = read_xattr(path, DEFAULT)?;
    Ok(
        access.is_some_and(|value| posix::lets_others_write(&value, own, false))
            || default.is_some_and(|value| posix::lets_others_write(&value, own, true)),
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_xattr(path: &Path, name: &std::ffi::CStr) -> std::io::Result<Option<Vec<u8>>> {
    let file = c_path(path)?;
    // SAFETY: both C strings are live; the buffer has the supplied size.
    xattr(|value, size| unsafe { libc::lgetxattr(file.as_ptr(), name.as_ptr(), value, size) })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_fd_xattr(fd: libc::c_int, name: &std::ffi::CStr) -> std::io::Result<Option<Vec<u8>>> {
    // SAFETY: the caller keeps the descriptor open; the buffer has the supplied size.
    xattr(|value, size| unsafe { libc::fgetxattr(fd, name.as_ptr(), value, size) })
}

/// `get` is asked for the size with a null buffer, then for the value.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn xattr(get: impl Fn(*mut libc::c_void, usize) -> isize) -> std::io::Result<Option<Vec<u8>>> {
    loop {
        let size = get(std::ptr::null_mut(), 0);
        if size < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENODATA | libc::ENOTSUP) => Ok(None),
                _ => Err(error),
            };
        }
        let mut value = vec![0u8; size.unsigned_abs()];
        let read = get(value.as_mut_ptr().cast(), value.len());
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

#[cfg(any(target_os = "linux", target_os = "android"))]
const ACCESS: &std::ffi::CStr = c"system.posix_acl_access";
#[cfg(any(target_os = "linux", target_os = "android"))]
const DEFAULT: &std::ffi::CStr = c"system.posix_acl_default";

/// Mode bits cover access ACL group and other entries; default ACLs need a separate check.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn reach(file: &impl std::os::fd::AsRawFd, own: u32) -> std::io::Result<Reach> {
    let fd = file.as_raw_fd();
    Ok(Reach {
        itself: read_fd_xattr(fd, ACCESS)?
            .is_some_and(|value| posix::grants(&value, own, false, 0o7)),
        passed_on: read_fd_xattr(fd, DEFAULT)?
            .is_some_and(|value| posix::grants(&value, own, true, 0o7)),
    })
}

/// Removes an open file's or folder's access and default ACLs; its mode stays.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn clear(file: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    let fd = file.as_raw_fd();
    for name in [ACCESS, DEFAULT] {
        if read_fd_xattr(fd, name)?.is_none() {
            continue;
        }
        // SAFETY: the descriptor is open and the name is a live C string.
        if unsafe { libc::fremovexattr(fd, name.as_ptr()) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENODATA) {
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg_attr(not(any(target_os = "linux", target_os = "android")), allow(dead_code))]
mod posix {
    #[cfg(any(test, feature = "testing"))]
    pub const USER_OBJ: u16 = 0x01;
    pub const NAMED_USER: u16 = 0x02;
    pub const GROUP_OBJ: u16 = 0x04;
    pub const NAMED_GROUP: u16 = 0x08;
    pub const MASK: u16 = 0x10;
    pub const OTHER: u16 = 0x20;
    const WRITE: u16 = 0x02;

    #[derive(Clone, Copy)]
    struct Entry {
        tag: u16,
        permissions: u16,
        id: u32,
    }

    // Linux stores a 4-byte header, then 8-byte little-endian tag/permissions/id entries.
    fn entries(value: &[u8]) -> impl Iterator<Item = Entry> + '_ {
        value
            .get(4..)
            .unwrap_or_default()
            .as_chunks::<8>()
            .0
            .iter()
            .map(|&[t0, t1, p0, p1, i0, i1, i2, i3]| Entry {
                tag: u16::from_le_bytes([t0, t1]),
                permissions: u16::from_le_bytes([p0, p1]),
                id: u32::from_le_bytes([i0, i1, i2, i3]),
            })
    }

    pub fn names_others(value: &[u8]) -> bool {
        entries(value).any(|entry| entry.tag == NAMED_USER || entry.tag == NAMED_GROUP)
    }

    // Callers check access ACL group/other mode bits; default ACLs need a separate check.
    pub fn lets_others_write(value: &[u8], own: u32, default: bool) -> bool {
        grants(value, own, default, WRITE)
    }

    pub fn grants(value: &[u8], own: u32, default: bool, wanted: u16) -> bool {
        let mask = entries(value)
            .find(|entry| entry.tag == MASK)
            .map_or(0o7, |entry| entry.permissions);
        entries(value).any(|entry| {
            let effective = match entry.tag {
                NAMED_USER if entry.id != own => entry.permissions & mask,
                NAMED_GROUP => entry.permissions & mask,
                GROUP_OBJ if default => entry.permissions & mask,
                OTHER if default => entry.permissions,
                _ => 0,
            };
            effective & wanted != 0
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
pub fn grants_by_acl(_path: &Path) -> std::io::Result<bool> {
    Err(unsupported())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
pub fn others_may_write(_path: &Path, _own: u32) -> std::io::Result<bool> {
    Err(unsupported())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
pub fn reach(_file: &impl std::os::fd::AsRawFd, _own: u32) -> std::io::Result<Reach> {
    Err(unsupported())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
pub fn clear(_file: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    Err(unsupported())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
fn unsupported() -> std::io::Error {
    std::io::Error::new(
        ErrorKind::Unsupported,
        "a private control socket needs macOS or Linux",
    )
}

/// Gives another account an ACL entry on a folder, for tests of the callers.
#[cfg(any(test, feature = "testing"))]
pub mod testing {
    use std::path::Path;

    #[derive(Clone, Copy, Debug)]
    pub enum Grant {
        /// List and search the folder.
        Read,
        /// Add and remove what the folder holds.
        Write,
        /// List and search what is made inside.
        InheritRead,
        /// Add and remove inside what is made inside.
        InheritWrite,
        /// Read a file.
        ReadFile,
        /// Read the files made inside.
        InheritReadToFiles,
    }

    /// Returns whether the requested grant could be set on the file or folder.
    #[cfg(target_os = "macos")]
    pub fn let_another_account(folder: &Path, grant: Grant) -> bool {
        let entry = match grant {
            Grant::ReadFile => "everyone allow read",
            Grant::InheritReadToFiles => "everyone allow read,file_inherit,only_inherit",
            Grant::Read => "everyone allow list,search",
            Grant::Write => "everyone allow list,search,add_file,delete_child",
            Grant::InheritRead => "everyone allow list,search,directory_inherit,only_inherit",
            Grant::InheritWrite => "everyone allow add_subdirectory,directory_inherit,only_inherit",
        };
        let status = std::process::Command::new("/bin/chmod")
            .args(["+a", entry])
            .arg(folder)
            .status()
            .expect("chmod runs");
        assert!(status.success(), "chmod +a {entry:?}");
        true
    }

    /// Returns false if ACLs cannot be set; read grants preserve group mode bits.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn let_another_account(folder: &Path, grant: Grant) -> bool {
        use crate::posix::{GROUP_OBJ, MASK, NAMED_USER, OTHER, USER_OBJ};
        use std::os::unix::fs::MetadataExt;

        const NOBODY: u32 = 65534;
        const NONE: u32 = u32::MAX;
        let mode = std::fs::metadata(folder).expect("folder").mode();
        let (owner, group, others) = (
            ((mode >> 6) & 7) as u16,
            ((mode >> 3) & 7) as u16,
            (mode & 7) as u16,
        );
        let (name, entries): (&std::ffi::CStr, [(u16, u16, u32); 5]) = match grant {
            Grant::Read | Grant::ReadFile => (
                c"system.posix_acl_access",
                [
                    (USER_OBJ, owner, NONE),
                    (NAMED_USER, 5, NOBODY),
                    (GROUP_OBJ, group, NONE),
                    (MASK, group, NONE),
                    (OTHER, others, NONE),
                ],
            ),
            Grant::Write => (
                c"system.posix_acl_access",
                [
                    (USER_OBJ, owner, NONE),
                    (NAMED_USER, 7, NOBODY),
                    (GROUP_OBJ, group, NONE),
                    (MASK, group | 7, NONE),
                    (OTHER, others, NONE),
                ],
            ),
            Grant::InheritRead | Grant::InheritWrite | Grant::InheritReadToFiles => {
                let named = if matches!(grant, Grant::InheritRead | Grant::InheritReadToFiles) {
                    5
                } else {
                    7
                };
                (
                    c"system.posix_acl_default",
                    [
                        (USER_OBJ, 7, NONE),
                        (NAMED_USER, named, NOBODY),
                        (GROUP_OBJ, 5, NONE),
                        (MASK, named | 5, NONE),
                        (OTHER, 5, NONE),
                    ],
                )
            }
        };
        set_posix_acl(folder, name, &entries)
    }

    /// False when this file system keeps no POSIX ACLs.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub(crate) fn set_posix_acl(
        path: &Path,
        name: &std::ffi::CStr,
        entries: &[(u16, u16, u32)],
    ) -> bool {
        let mut value = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in entries {
            value.extend_from_slice(&tag.to_le_bytes());
            value.extend_from_slice(&permissions.to_le_bytes());
            value.extend_from_slice(&id.to_le_bytes());
        }
        let file = super::c_path(path).expect("a path without NUL");
        // SAFETY: the names and the buffer outlive the call, and the size is the buffer's.
        let status = unsafe {
            libc::setxattr(
                file.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        };
        if status == 0 {
            return true;
        }
        let error = std::io::Error::last_os_error();
        assert!(
            matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EPERM)),
            "{error}"
        );
        false
    }
}

#[cfg(test)]
mod tests {
    use super::posix::*;
    use super::*;

    fn acl(entries: &[(u16, u16, u32)]) -> Vec<u8> {
        let mut bytes = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in entries {
            bytes.extend_from_slice(&tag.to_le_bytes());
            bytes.extend_from_slice(&permissions.to_le_bytes());
            bytes.extend_from_slice(&id.to_le_bytes());
        }
        bytes
    }

    const NONE: u32 = u32::MAX;

    #[test]
    fn an_acl_naming_another_account_is_seen() {
        let plain = [(USER_OBJ, 7, NONE), (GROUP_OBJ, 7, NONE), (OTHER, 7, NONE)];
        assert!(!names_others(&acl(&plain)));
        assert!(names_others(&acl(&[
            (USER_OBJ, 7, NONE),
            (NAMED_USER, 7, 7),
            (GROUP_OBJ, 7, NONE),
            (MASK, 7, NONE),
            (OTHER, 7, NONE)
        ])));
        assert!(names_others(&acl(&[
            (USER_OBJ, 7, NONE),
            (GROUP_OBJ, 7, NONE),
            (NAMED_GROUP, 7, 7),
            (MASK, 7, NONE),
            (OTHER, 7, NONE)
        ])));
    }

    #[test]
    fn only_write_that_the_mask_leaves_to_another_account_counts() {
        let me = 501;
        let with = |named: (u16, u16, u32), mask: u16| {
            acl(&[
                (USER_OBJ, 7, NONE),
                named,
                (GROUP_OBJ, 5, NONE),
                (MASK, mask, NONE),
                (OTHER, 5, NONE),
            ])
        };
        for default in [false, true] {
            assert!(!lets_others_write(
                &with((NAMED_USER, 5, 7), 5),
                me,
                default
            ));
            assert!(!lets_others_write(
                &with((NAMED_GROUP, 4, 7), 5),
                me,
                default
            ));
            assert!(lets_others_write(&with((NAMED_USER, 7, 7), 7), me, default));
            assert!(lets_others_write(
                &with((NAMED_GROUP, 6, 7), 7),
                me,
                default
            ));
            assert!(!lets_others_write(
                &with((NAMED_USER, 7, 7), 5),
                me,
                default
            ));
            assert!(!lets_others_write(
                &with((NAMED_USER, 7, me), 7),
                me,
                default
            ));
        }
        let open_group = acl(&[(USER_OBJ, 7, NONE), (GROUP_OBJ, 7, NONE), (OTHER, 5, NONE)]);
        let open_other = acl(&[(USER_OBJ, 7, NONE), (GROUP_OBJ, 5, NONE), (OTHER, 7, NONE)]);
        assert!(!lets_others_write(&open_group, me, false));
        assert!(!lets_others_write(&open_other, me, false));
        assert!(lets_others_write(&open_group, me, true));
        assert!(lets_others_write(&open_other, me, true));
    }

    fn folder(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("marfa-acl-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn me() -> u32 {
        // SAFETY: `geteuid` takes nothing and cannot fail.
        unsafe { libc::geteuid() }
    }

    #[test]
    fn the_walk_starts_at_the_root_and_ends_at_the_path() {
        let walked = |path: &str| {
            folders_from_root(Path::new(path)).map(|folders| {
                folders
                    .iter()
                    .map(|f| f.display().to_string())
                    .collect::<Vec<_>>()
            })
        };
        assert_eq!(walked("/"), Some(vec!["/".to_string()]));
        assert_eq!(
            walked("/srv/marfa"),
            Some(vec!["/".into(), "/srv".into(), "/srv/marfa".into()])
        );
        for wrong in ["srv/marfa", "./marfa", "/srv/../marfa"] {
            assert_eq!(walked(wrong), None, "{wrong}");
        }
    }

    #[test]
    fn a_folder_is_judged_by_link_kind_owner_and_mode() {
        let me = 501;
        let folder = |owner, mode| by_mode(false, true, owner, mode, me);
        assert_eq!(by_mode(true, true, me, 0o700, me), Some(Exposure::Link));
        assert_eq!(
            by_mode(false, false, me, 0o600, me),
            Some(Exposure::NotFolder)
        );
        assert_eq!(folder(502, 0o700), Some(Exposure::Owner));
        for open in [0o770, 0o702, 0o777] {
            assert_eq!(folder(me, open), Some(Exposure::Mode), "{open:o}");
        }
        assert_eq!(folder(0, 0o777), Some(Exposure::Mode));
        assert_eq!(folder(me, 0o1777), Some(Exposure::Mode));
        assert_eq!(folder(0, 0o1777), None);
        assert_eq!(folder(0, 0o755), None);
        assert_eq!(folder(me, 0o755), None);
    }

    #[test]
    fn the_real_root_lets_no_other_account_replace_what_it_holds() {
        let root = Path::new("/");
        let found = std::fs::symlink_metadata(root).unwrap();
        assert_eq!(exposure(root, &found, me()).unwrap(), None);
    }

    #[test]
    fn a_plain_folder_grants_nothing() {
        let path = folder("plain");
        assert!(!grants_by_acl(&path).unwrap());
        assert!(!others_may_write(&path, me()).unwrap());
        std::fs::remove_dir_all(&path).unwrap();
    }

    #[test]
    fn a_missing_path_is_an_error_on_linux_and_nothing_on_macos() {
        let path = folder("missing").join("absent");
        let found = grants_by_acl(&path);
        let written = others_may_write(&path, me());
        if cfg!(target_os = "macos") {
            assert!(!found.unwrap());
            assert!(!written.unwrap());
        } else {
            assert!(found.is_err());
            assert!(written.is_err());
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn a_named_user_or_group_or_a_default_acl_grants_and_the_owner_alone_does_not() {
        use testing::set_posix_acl;
        let access = c"system.posix_acl_access";
        let default = c"system.posix_acl_default";
        let user_obj = (USER_OBJ, 7, NONE);
        let group_obj = (GROUP_OBJ, 5, NONE);
        let mask = (MASK, 7, NONE);
        let other = (OTHER, 0, NONE);

        let named_user = folder("named-user");
        if !set_posix_acl(
            &named_user,
            access,
            &[user_obj, (NAMED_USER, 7, 65534), group_obj, mask, other],
        ) {
            eprintln!("skipped: this file system keeps no POSIX ACLs");
            std::fs::remove_dir_all(&named_user).unwrap();
            return;
        }
        assert!(grants_by_acl(&named_user).unwrap());
        std::fs::remove_dir_all(&named_user).unwrap();

        let named_group = folder("named-group");
        assert!(set_posix_acl(
            &named_group,
            access,
            &[user_obj, group_obj, (NAMED_GROUP, 7, 65534), mask, other],
        ));
        assert!(grants_by_acl(&named_group).unwrap());
        std::fs::remove_dir_all(&named_group).unwrap();

        let inherited = folder("default");
        assert!(set_posix_acl(
            &inherited,
            default,
            &[user_obj, group_obj, other]
        ));
        assert!(grants_by_acl(&inherited).unwrap());
        std::fs::remove_dir_all(&inherited).unwrap();

        // The kernel folds an ACL that only restates the mode into the mode.
        let minimal = folder("minimal");
        assert!(set_posix_acl(
            &minimal,
            access,
            &[user_obj, group_obj, other]
        ));
        assert!(!grants_by_acl(&minimal).unwrap());
        std::fs::remove_dir_all(&minimal).unwrap();
    }

    #[test]
    fn read_for_another_account_does_not_write_and_write_or_inherited_write_does() {
        use std::os::unix::fs::PermissionsExt;
        use testing::{Grant, let_another_account};
        for (grant, writes) in [
            (Grant::Read, false),
            (Grant::Write, true),
            (Grant::InheritRead, false),
            (Grant::InheritWrite, true),
        ] {
            let path = folder("grant");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            if !let_another_account(&path, grant) {
                eprintln!("skipped: this file system keeps no POSIX ACLs");
                std::fs::remove_dir_all(&path).unwrap();
                return;
            }
            assert!(grants_by_acl(&path).unwrap(), "{grant:?}");
            assert_eq!(others_may_write(&path, me()).unwrap(), writes, "{grant:?}");
            std::fs::remove_dir_all(&path).unwrap();
        }
    }

    #[test]
    fn what_reaches_another_account_is_seen_on_an_open_file_and_cleared() {
        use std::os::unix::fs::PermissionsExt;
        use testing::{Grant, let_another_account};
        let at = folder("reach");
        let file = at.join("file");
        std::fs::write(&file, "x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        let opened = |path: &Path| std::fs::File::open(path).unwrap();
        assert_eq!(reach(&opened(&at), me()).unwrap(), Reach::default());
        assert_eq!(reach(&opened(&file), me()).unwrap(), Reach::default());
        if !let_another_account(&file, Grant::ReadFile) {
            eprintln!("skipped: this file system keeps no POSIX ACLs");
            std::fs::remove_dir_all(&at).unwrap();
            return;
        }
        assert!(let_another_account(&at, Grant::InheritReadToFiles));
        let file_reach = reach(&opened(&file), me()).unwrap();
        assert!(file_reach.itself, "{file_reach:?}");
        let folder_reach = reach(&opened(&at), me()).unwrap();
        assert!(
            folder_reach.passed_on && !folder_reach.itself,
            "{folder_reach:?}"
        );
        clear(&opened(&file)).unwrap();
        clear(&opened(&at)).unwrap();
        assert_eq!(reach(&opened(&at), me()).unwrap(), Reach::default());
        assert_eq!(reach(&opened(&file), me()).unwrap(), Reach::default());
        std::fs::remove_dir_all(&at).unwrap();
    }

    #[cfg(target_os = "macos")]
    fn chmod(arguments: &[&str], path: &Path) {
        let status = std::process::Command::new("/bin/chmod")
            .args(arguments)
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "chmod {arguments:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_allow_entry_grants_and_a_deny_entry_does_not() {
        let deny = folder("deny");
        chmod(&["+a", "everyone deny delete"], &deny);
        assert!(!grants_by_acl(&deny).unwrap());
        chmod(&["+a", "everyone allow list,search"], &deny);
        assert!(grants_by_acl(&deny).unwrap());
        chmod(&["-N"], &deny);
        std::fs::remove_dir_all(&deny).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_allow_entry_that_writes_counts_and_a_deny_entry_or_a_read_does_not() {
        let at = folder("writes");
        let path = at.join("file");
        std::fs::write(&path, "x").unwrap();
        let me = me();
        let check = |path: &Path| {
            let by_path = others_may_write(path, me).unwrap();
            let by_file = others_may_write_file(&std::fs::File::open(path).unwrap(), me).unwrap();
            assert_eq!(by_path, by_file, "{}", path.display());
            by_path
        };
        assert!(!check(&path));
        assert!(!check(&at));
        chmod(&["+a", "everyone deny delete"], &path);
        chmod(&["+a", "everyone deny delete"], &at);
        assert!(!check(&path));
        assert!(!check(&at));
        chmod(&["+a", "everyone allow read"], &path);
        chmod(&["+a", "everyone allow list,search"], &at);
        assert!(!check(&path));
        assert!(!check(&at));
        for (right, on_folder) in [
            ("write", false),
            ("append", false),
            ("writeattr", false),
            ("writeextattr", false),
            ("writesecurity", false),
            ("chown", false),
            ("delete", false),
            ("add_file", true),
            ("add_subdirectory", true),
            ("delete_child", true),
            ("delete", true),
            ("writesecurity", true),
            ("add_subdirectory,directory_inherit,only_inherit", true),
        ] {
            let target = if on_folder { &at } else { &path };
            let entry = format!("everyone allow {right}");
            chmod(&["+a", &entry], target);
            assert!(check(target), "{right}");
            chmod(&["-a", &entry], target);
            assert!(!check(target), "{right} removed");
        }
        // The owner's own entry gives nobody else anything.
        let user = std::env::var("USER").unwrap_or_default();
        if !user.is_empty() {
            chmod(&["+a", &format!("user:{user} allow write")], &path);
            assert!(!check(&path));
            chmod(&["+a", &format!("user:{user} allow add_file")], &at);
            assert!(!check(&at));
        }
        // The deny entries keep even the owner from deleting.
        chmod(&["-N"], &path);
        chmod(&["-N"], &at);
        std::fs::remove_dir_all(at).unwrap();
    }
}
