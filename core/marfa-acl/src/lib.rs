use std::ffi::CString;
use std::io::ErrorKind;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

fn c_path(path: &Path) -> std::io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(ErrorKind::InvalidInput))
}

/// Deny entries only restrict access; any allow entry counts as a grant.
#[cfg(target_os = "macos")]
pub fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
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
    // SAFETY: `name` is a live C string; entries borrow the ACL, freed below.
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

/// Named entries and default ACLs count as grants, regardless of their mask.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn grants_by_acl(path: &Path) -> std::io::Result<bool> {
    if read_xattr(path, c"system.posix_acl_default")?.is_some_and(|value| value.len() > 4) {
        return Ok(true);
    }
    Ok(read_xattr(path, c"system.posix_acl_access")?.is_some_and(|value| names_others(&value)))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_xattr(path: &Path, name: &std::ffi::CStr) -> std::io::Result<Option<Vec<u8>>> {
    let file = c_path(path)?;
    loop {
        // SAFETY: both C strings are live; the buffer has the supplied size.
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

// The kernel format has a four-byte header and eight-byte entries, tag first.
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
pub fn grants_by_acl(_path: &Path) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        ErrorKind::Unsupported,
        "a private control socket needs macOS or Linux",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn folder(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("marfa-acl-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn a_plain_folder_grants_nothing() {
        let path = folder("plain");
        assert!(!grants_by_acl(&path).unwrap());
        std::fs::remove_dir_all(&path).unwrap();
    }

    #[test]
    fn a_missing_path_is_an_error_on_linux_and_nothing_on_macos() {
        let path = folder("missing").join("absent");
        let found = grants_by_acl(&path);
        if cfg!(target_os = "macos") {
            assert!(!found.unwrap());
        } else {
            assert!(found.is_err());
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    /// `None` when this file system keeps no ACLs, so the caller skips.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn set_posix_acl(
        path: &Path,
        name: &std::ffi::CStr,
        entries: &[(u16, u16, u32)],
    ) -> Option<()> {
        let mut value = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in entries {
            value.extend_from_slice(&tag.to_le_bytes());
            value.extend_from_slice(&permissions.to_le_bytes());
            value.extend_from_slice(&id.to_le_bytes());
        }
        let file = c_path(path).unwrap();
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
            return Some(());
        }
        let error = std::io::Error::last_os_error();
        assert!(
            matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::EPERM)),
            "{error}"
        );
        None
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const USER_OBJ: (u16, u16, u32) = (0x01, 7, u32::MAX);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const GROUP_OBJ: (u16, u16, u32) = (0x04, 5, u32::MAX);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const MASK: (u16, u16, u32) = (0x10, 7, u32::MAX);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const OTHER: (u16, u16, u32) = (0x20, 0, u32::MAX);

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn a_named_user_or_group_or_a_default_acl_grants_and_the_owner_alone_does_not() {
        let access = c"system.posix_acl_access";
        let default = c"system.posix_acl_default";

        let named_user = folder("named-user");
        if set_posix_acl(
            &named_user,
            access,
            &[USER_OBJ, (0x02, 7, 65534), GROUP_OBJ, MASK, OTHER],
        )
        .is_none()
        {
            eprintln!("skipped: this file system keeps no POSIX ACLs");
            std::fs::remove_dir_all(&named_user).unwrap();
            return;
        }
        assert!(grants_by_acl(&named_user).unwrap());
        std::fs::remove_dir_all(&named_user).unwrap();

        let named_group = folder("named-group");
        set_posix_acl(
            &named_group,
            access,
            &[USER_OBJ, GROUP_OBJ, (0x08, 7, 65534), MASK, OTHER],
        )
        .unwrap();
        assert!(grants_by_acl(&named_group).unwrap());
        std::fs::remove_dir_all(&named_group).unwrap();

        let inherited = folder("default");
        set_posix_acl(&inherited, default, &[USER_OBJ, GROUP_OBJ, OTHER]).unwrap();
        assert!(grants_by_acl(&inherited).unwrap());
        std::fs::remove_dir_all(&inherited).unwrap();

        // The kernel folds an ACL that only restates the mode into the mode.
        let minimal = folder("minimal");
        set_posix_acl(&minimal, access, &[USER_OBJ, GROUP_OBJ, OTHER]).unwrap();
        assert!(!grants_by_acl(&minimal).unwrap());
        std::fs::remove_dir_all(&minimal).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_allow_entry_grants_and_a_deny_entry_does_not() {
        let chmod = |path: &Path, entry: &str| {
            let status = std::process::Command::new("/bin/chmod")
                .args(["+a", entry])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let deny = folder("deny");
        chmod(&deny, "everyone deny delete");
        assert!(!grants_by_acl(&deny).unwrap());
        chmod(&deny, "everyone allow list,search");
        assert!(grants_by_acl(&deny).unwrap());
        let cleared = std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(&deny)
            .status()
            .unwrap();
        assert!(cleared.success());
        std::fs::remove_dir_all(&deny).unwrap();
    }
}
