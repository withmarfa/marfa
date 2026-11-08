use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

pub fn free_bytes(path: &Path) -> Option<u64> {
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` writes only into the struct it is given, and `path`
    // is a NUL-terminated string that outlives the call.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    let answered = unsafe { libc::statvfs(path.as_ptr(), &mut stats) };
    // The two fields are narrower than u64 on some platforms and not others.
    #[allow(clippy::useless_conversion)]
    (answered == 0).then(|| u64::from(stats.f_bavail) * u64::from(stats.f_frsize))
}
