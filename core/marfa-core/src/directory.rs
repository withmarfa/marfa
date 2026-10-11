#[cfg(unix)]
#[path = "directory_unix.rs"]
mod implementation;
#[cfg(not(unix))]
#[path = "directory_unsupported.rs"]
mod implementation;

pub(crate) use implementation::{Directory, FileType, Mode, OFlags};
