//! Whether a file's extended ACL lets anyone but its owner change it, which
//! its mode bits do not show on macOS.

use std::os::fd::AsRawFd;

#[allow(non_camel_case_types)]
type acl_t = *mut libc::c_void;
#[allow(non_camel_case_types)]
type acl_entry_t = *mut libc::c_void;

const ACL_TYPE_EXTENDED: libc::c_int = 0x0000_0100;
const ACL_FIRST_ENTRY: libc::c_int = 0;
const ACL_NEXT_ENTRY: libc::c_int = -1;
const ACL_EXTENDED_ALLOW: libc::c_int = 1;
const ID_TYPE_UID: libc::c_int = 0;

/// The rights that change a file or what a folder holds, from `sys/acl.h`:
/// write data or add a file, append data or add a subdirectory, delete, delete
/// a child, write attributes, write extended attributes, write security and
/// change owner.
const WRITE_RIGHTS: u64 =
    (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 12) | (1 << 13);

unsafe extern "C" {
    fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> acl_t;
    fn acl_get_entry(acl: acl_t, entry_id: libc::c_int, entry: *mut acl_entry_t) -> libc::c_int;
    fn acl_get_tag_type(entry: acl_entry_t, tag: *mut libc::c_int) -> libc::c_int;
    fn acl_get_permset_mask_np(entry: acl_entry_t, mask: *mut u64) -> libc::c_int;
    fn acl_get_qualifier(entry: acl_entry_t) -> *mut libc::c_void;
    fn acl_free(object: *mut libc::c_void) -> libc::c_int;
    fn mbr_uuid_to_id(
        uuid: *const u8,
        id: *mut libc::id_t,
        id_type: *mut libc::c_int,
    ) -> libc::c_int;
}

/// Frees an ACL or a qualifier when dropped.
struct Freed(*mut libc::c_void);

impl Drop for Freed {
    fn drop(&mut self) {
        // SAFETY: the pointer came from `acl_get_fd_np` or `acl_get_qualifier`.
        unsafe { acl_free(self.0) };
    }
}

/// Whether an allow entry for anyone but `owner` grants a right that writes.
/// Deny entries take rights away, so they never count: macOS ships the home
/// folder's `Library` with one denying everyone delete.
pub fn others_may_write(file: &impl AsRawFd, owner: u32) -> std::io::Result<bool> {
    // SAFETY: the descriptor is open for as long as `file` is borrowed.
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            // No extended ACL, or a file system that keeps none.
            Some(libc::ENOENT) | Some(libc::EOPNOTSUPP) => Ok(false),
            _ => Err(error),
        };
    }
    let acl = Freed(acl);
    let mut entry: acl_entry_t = std::ptr::null_mut();
    let mut which = ACL_FIRST_ENTRY;
    // SAFETY: `acl` is a valid ACL and `entry` is written before it is read.
    while unsafe { acl_get_entry(acl.0, which, &mut entry) } == 0 {
        which = ACL_NEXT_ENTRY;
        let mut tag = 0;
        let mut rights = 0u64;
        // SAFETY: `entry` is an entry of `acl`, which outlives it.
        unsafe {
            if acl_get_tag_type(entry, &mut tag) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if acl_get_permset_mask_np(entry, &mut rights) != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        if tag != ACL_EXTENDED_ALLOW || rights & WRITE_RIGHTS == 0 {
            continue;
        }
        if !names_only(entry, owner) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the entry names the user `owner`. A group, or a name that cannot be
/// resolved, is someone else.
fn names_only(entry: acl_entry_t, owner: u32) -> bool {
    // SAFETY: for an extended entry the qualifier is a 16-byte UUID, freed
    // with `acl_free`.
    let qualifier = unsafe { acl_get_qualifier(entry) };
    if qualifier.is_null() {
        return false;
    }
    let qualifier = Freed(qualifier);
    let mut id: libc::id_t = 0;
    let mut kind = -1;
    // SAFETY: the qualifier holds 16 bytes and both outputs are valid.
    let resolved = unsafe { mbr_uuid_to_id(qualifier.0 as *const u8, &mut id, &mut kind) };
    resolved == 0 && kind == ID_TYPE_UID && id == owner
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn chmod(arguments: &[&str], path: &std::path::Path) {
        let status = Command::new("/bin/chmod")
            .args(arguments)
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success(), "chmod {arguments:?}");
    }

    #[test]
    fn an_allow_entry_that_writes_counts_and_a_deny_entry_or_a_read_does_not() {
        let at = std::env::temp_dir().join(format!("marfa-acl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&at);
        std::fs::create_dir_all(&at).unwrap();
        let path = at.join("file");
        std::fs::write(&path, "x").unwrap();
        // SAFETY: `geteuid` cannot fail.
        let me = unsafe { libc::geteuid() };
        let check = |path: &std::path::Path| {
            others_may_write(&std::fs::File::open(path).unwrap(), me).unwrap()
        };
        assert!(!check(&path));
        assert!(!check(&at));
        chmod(&["+a", "everyone deny delete"], &path);
        chmod(&["+a", "everyone deny delete"], &at);
        assert!(!check(&path));
        assert!(!check(&at));
        chmod(&["+a", "everyone allow read"], &path);
        assert!(!check(&path));
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
        }
        // The deny entries keep even the owner from deleting.
        chmod(&["-N"], &path);
        chmod(&["-N"], &at);
        std::fs::remove_dir_all(at).unwrap();
    }
}
