use std::{
    ffi::OsString,
    fs::{File, Metadata},
    io,
    path::Path,
};

#[derive(Clone, Debug)]
pub(crate) struct Directory {
    file: std::sync::Arc<File>,
}

#[derive(Clone, Copy)]
pub(crate) struct OFlags;
impl OFlags {
    pub(crate) const RDONLY: Self = Self;
    pub(crate) const WRONLY: Self = Self;
    pub(crate) const RDWR: Self = Self;
    pub(crate) const CREATE: Self = Self;
    pub(crate) const EXCL: Self = Self;
    pub(crate) const APPEND: Self = Self;
}
impl std::ops::BitOr for OFlags {
    type Output = Self;
    fn bitor(self, _: Self) -> Self {
        Self
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Mode;
impl Mode {
    pub(crate) fn empty() -> Self {
        Self
    }
    pub(crate) fn from_raw_mode(_: u32) -> Self {
        Self
    }
}

#[derive(PartialEq)]
#[allow(dead_code)] // No entry can be opened on an unsupported platform.
pub(crate) enum FileType {
    Directory,
    RegularFile,
    Symlink,
}

fn unsupported<T>() -> io::Result<T> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "folder directory capabilities are unavailable on this platform",
    ))
}

impl Directory {
    pub(crate) fn open(_: &Path) -> io::Result<Self> {
        unsupported()
    }
    pub(crate) fn create(_: &Path) -> io::Result<Self> {
        unsupported()
    }
    pub(crate) fn child(&self, _: &Path, _: bool) -> io::Result<Self> {
        unsupported()
    }
    pub(crate) fn file(&self) -> &File {
        &self.file
    }
    pub(crate) fn parent(&self, _: &Path, _: bool) -> io::Result<(Self, OsString)> {
        unsupported()
    }
    pub(crate) fn open_file(&self, _: &Path, _: OFlags, _: Mode) -> io::Result<File> {
        unsupported()
    }
    pub(crate) fn capture_file(&self, _: &Path) -> io::Result<File> {
        unsupported()
    }
    pub(crate) fn read(&self, _: &Path) -> io::Result<Vec<u8>> {
        unsupported()
    }
    pub(crate) fn entry_metadata(&self, _: &Path) -> io::Result<Metadata> {
        unsupported()
    }
    pub(crate) fn entry_kind(&self, _: &Path) -> io::Result<FileType> {
        unsupported()
    }
    pub(crate) fn entry_identity(&self, _: &Path) -> io::Result<(u64, u64)> {
        unsupported()
    }
    pub(crate) fn observed_identity(&self, _: &Path) -> io::Result<Option<(u64, u64, u128)>> {
        unsupported()
    }
    pub(crate) fn contains_no_files(&self) -> io::Result<bool> {
        unsupported()
    }
    pub(crate) fn clear(&self) -> io::Result<()> {
        unsupported()
    }
    pub(crate) fn entries(&self) -> io::Result<Vec<OsString>> {
        unsupported()
    }
    pub(crate) fn unlink(&self, _: &Path) -> io::Result<()> {
        unsupported()
    }
    pub(crate) fn rename(&self, _: &Path, _: &Self, _: &Path, _: bool) -> io::Result<()> {
        unsupported()
    }
    pub(crate) fn sync(&self) -> io::Result<()> {
        unsupported()
    }
    pub(crate) fn same(&self, _: &Self) -> io::Result<bool> {
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_before_creating_any_state() {
        let path = std::env::temp_dir().join(format!("marfa-unsupported-{}", std::process::id()));
        assert!(!path.exists());
        assert_eq!(
            Directory::create(&path).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        assert_eq!(
            Directory::open(&path).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        assert!(!path.exists());
    }
}
