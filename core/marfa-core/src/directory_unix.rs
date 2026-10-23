use rustix::fs::{self, AtFlags};
pub(crate) use rustix::fs::{FileType, Mode, OFlags};
use rustix::io::Errno;
use std::{
    ffi::OsString,
    fs::{File, Metadata},
    io::{self, Read},
    path::{Component, Path},
    sync::Arc,
};

/// Every traversal step retains its directory; a path is only an entry label.
#[derive(Clone, Debug)]
pub(crate) struct Directory {
    file: Arc<File>,
}

/// A directory a call made, held with the directory it was made in, so it
/// can be taken back by its name without following a link.
#[derive(Debug)]
pub(crate) struct MadeDirectory {
    parent: Directory,
    name: OsString,
    directory: Directory,
}

impl MadeDirectory {
    /// Removes the directory where it still stands, empty, at its name.
    /// Answers whether it was removed.
    pub(crate) fn take_back(&self) -> io::Result<bool> {
        self.parent
            .remove_dir(Path::new(&self.name), &self.directory)
    }
}

impl Directory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        Self::open_with(path, None)
    }

    pub(crate) fn create(path: &Path) -> io::Result<Self> {
        Self::open_with(path, Some(&mut Vec::new()))
    }

    /// `create`, recording in `made` each directory this call made, first
    /// made first.
    pub(crate) fn create_recorded(path: &Path, made: &mut Vec<MadeDirectory>) -> io::Result<Self> {
        Self::open_with(path, Some(made))
    }

    fn open_with(path: &Path, mut made: Option<&mut Vec<MadeDirectory>>) -> io::Result<Self> {
        if !cfg!(any(target_vendor = "apple", target_os = "linux")) {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "directory capabilities are unavailable on this platform",
            ));
        }
        let mut components = path.components();
        let mut directory = if path.is_absolute() {
            components.next();
            Self::from_fd(fs::open(
                "/",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )?)
        } else {
            Self::from_fd(fs::open(
                ".",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )?)
        };
        for part in components {
            match part {
                Component::Normal(name) => {
                    directory = directory.reach(Path::new(name), made.as_deref_mut())?;
                }
                Component::CurDir => {}
                Component::ParentDir => directory = directory.up()?,
                _ => return Err(invalid_path()),
            }
        }
        Ok(directory)
    }

    /// The directory this one sits in, whatever path reached it.
    pub(crate) fn up(&self) -> io::Result<Self> {
        Ok(Self::from_fd(fs::openat(
            self.file(),
            "..",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?))
    }

    fn from_fd(fd: std::os::fd::OwnedFd) -> Self {
        Self {
            file: Arc::new(File::from(fd)),
        }
    }

    pub(crate) fn file(&self) -> &File {
        &self.file
    }

    pub(crate) fn metadata(&self) -> io::Result<Metadata> {
        self.file.metadata()
    }

    pub(crate) fn child(&self, relative: &Path, create: bool) -> io::Result<Self> {
        let mut made = Vec::new();
        self.reach(relative, create.then_some(&mut made))
    }

    /// `child`, making each missing directory and recording in `made` the
    /// ones this call made, first made first.
    pub(crate) fn child_recorded(
        &self,
        relative: &Path,
        made: &mut Vec<MadeDirectory>,
    ) -> io::Result<Self> {
        self.reach(relative, Some(made))
    }

    /// Walks `relative`, making each missing directory where `made` is
    /// given and recording there the ones made.
    fn reach(
        &self,
        relative: &Path,
        mut made: Option<&mut Vec<MadeDirectory>>,
    ) -> io::Result<Self> {
        let mut directory = self.clone();
        for part in relative.components() {
            let Component::Normal(name) = part else {
                return Err(invalid_path());
            };
            let created = made.is_some()
                && match fs::mkdirat(directory.file(), name, Mode::from_raw_mode(0o700)) {
                    Ok(()) => true,
                    Err(Errno::EXIST) => false,
                    Err(error) => return Err(error.into()),
                };
            let child = Self::from_fd(fs::openat(
                directory.file(),
                name,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            if created && let Some(made) = made.as_deref_mut() {
                made.push(MadeDirectory {
                    parent: directory,
                    name: name.to_owned(),
                    directory: child.clone(),
                });
            }
            directory = child;
        }
        Ok(directory)
    }

    pub(crate) fn parent(&self, relative: &Path, create: bool) -> io::Result<(Self, OsString)> {
        if relative.is_absolute() {
            return Err(invalid_path());
        }
        let name = relative.file_name().ok_or_else(invalid_path)?.to_owned();
        let parent = relative.parent().ok_or_else(invalid_path)?;
        Ok((self.child(parent, create)?, name))
    }

    pub(crate) fn open_file(&self, relative: &Path, flags: OFlags, mode: Mode) -> io::Result<File> {
        let (parent, name) = self.parent(relative, false)?;
        let file = File::from(fs::openat(
            parent.file(),
            &name,
            flags | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            mode,
        )?);
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the entry is not a regular file",
            ));
        }
        Ok(file)
    }

    /// Linux can retain an unreadable file without read access. Other systems
    /// leave it unopened; the walk may observe its identity solely to hold it.
    pub(crate) fn capture_file(&self, relative: &Path) -> io::Result<File> {
        match self.open_file(relative, OFlags::RDONLY, Mode::empty()) {
            #[cfg(target_os = "linux")]
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                self.open_file(relative, OFlags::PATH, Mode::empty())
            }
            result => result,
        }
    }

    pub(crate) fn observed_identity(
        &self,
        relative: &Path,
    ) -> io::Result<Option<(u64, u64, u128)>> {
        let (parent, name) = self.parent(relative, false)?;
        let stat = fs::statat(parent.file(), &name, AtFlags::SYMLINK_NOFOLLOW)?;
        if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::RegularFile {
            return Ok(None);
        }
        #[cfg(target_vendor = "apple")]
        return Ok(u128::try_from(stat.st_birthtime)
            .ok()
            .zip(u128::try_from(stat.st_birthtime_nsec).ok())
            .map(|(seconds, nanos)| {
                (
                    stat.st_dev as u64,
                    stat.st_ino as u64,
                    seconds * 1_000_000_000 + nanos,
                )
            }));
        #[cfg(not(target_vendor = "apple"))]
        Ok(None)
    }

    pub(crate) fn read(&self, relative: &Path) -> io::Result<Vec<u8>> {
        let mut file = self.open_file(relative, OFlags::RDONLY, Mode::empty())?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn entry_metadata(&self, relative: &Path) -> io::Result<Metadata> {
        self.open_file(relative, OFlags::RDONLY, Mode::empty())?
            .metadata()
    }

    /// The kind, length and modification time of the entry at `relative`,
    /// read without opening it or following a link.
    pub(crate) fn entry_stat(
        &self,
        relative: &Path,
    ) -> io::Result<(fs::FileType, u64, std::time::SystemTime)> {
        let (parent, name) = self.parent(relative, false)?;
        let stat = fs::statat(parent.file(), &name, AtFlags::SYMLINK_NOFOLLOW)?;
        let modified = u64::try_from(stat.st_mtime)
            .ok()
            .zip(u32::try_from(stat.st_mtime_nsec).ok())
            .map_or(std::time::UNIX_EPOCH, |(seconds, nanos)| {
                std::time::UNIX_EPOCH + std::time::Duration::new(seconds, nanos)
            });
        Ok((
            fs::FileType::from_raw_mode(stat.st_mode),
            u64::try_from(stat.st_size).unwrap_or(0),
            modified,
        ))
    }

    pub(crate) fn entry_kind(&self, relative: &Path) -> io::Result<fs::FileType> {
        let (parent, name) = self.parent(relative, false)?;
        let stat = fs::statat(parent.file(), &name, AtFlags::SYMLINK_NOFOLLOW)?;
        Ok(fs::FileType::from_raw_mode(stat.st_mode))
    }

    /// The device and inode of the symbolic link at `relative`, not of what
    /// it leads to.
    pub(crate) fn link_identity(&self, relative: &Path) -> io::Result<(u64, u64)> {
        let (parent, name) = self.parent(relative, false)?;
        let stat = fs::statat(parent.file(), &name, AtFlags::SYMLINK_NOFOLLOW)?;
        if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::Symlink {
            return Err(invalid_path());
        }
        Ok((stat.st_dev as u64, stat.st_ino as u64))
    }
    pub(crate) fn entry_identity(&self, relative: &Path) -> io::Result<(u64, u64)> {
        let (parent, name) = self.parent(relative, false)?;
        let stat = fs::statat(parent.file(), &name, AtFlags::SYMLINK_NOFOLLOW)?;
        if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::RegularFile {
            return Err(invalid_path());
        }
        Ok((stat.st_dev as u64, stat.st_ino as u64))
    }

    pub(crate) fn clear_tree(&self, relative: &Path) -> io::Result<()> {
        let (parent, name) = self.parent(relative, false)?;
        let original = parent.child(Path::new(&name), false)?;
        original.clear()
    }

    pub(crate) fn clear(&self) -> io::Result<()> {
        for name in self.entries()? {
            let name = Path::new(&name);
            match self.entry_kind(name)? {
                fs::FileType::Directory => self.clear_tree(name)?,
                _ => self.unlink(name)?,
            }
        }
        self.sync()
    }

    pub(crate) fn entries(&self) -> io::Result<Vec<OsString>> {
        let entries = fs::Dir::read_from(self.file())?;
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            if name.to_bytes() != b"." && name.to_bytes() != b".." {
                use std::os::unix::ffi::OsStringExt;
                names.push(OsString::from_vec(name.to_bytes().to_vec()));
            }
        }
        names.sort();
        Ok(names)
    }

    pub(crate) fn unlink(&self, relative: &Path) -> io::Result<()> {
        let (parent, name) = self.parent(relative, false)?;
        fs::unlinkat(parent.file(), &name, AtFlags::empty()).map_err(Into::into)
    }

    /// Removes the directory at `relative` where it is `expected` and empty,
    /// following no link. Answers whether it was removed: a directory that
    /// holds anything, or any other entry at that name, stays.
    pub(crate) fn remove_dir(&self, relative: &Path, expected: &Self) -> io::Result<bool> {
        let (parent, name) = self.parent(relative, false)?;
        let standing = match parent.child(Path::new(&name), false) {
            Ok(standing) => standing,
            Err(error)
                if matches!(
                    error.raw_os_error().map(Errno::from_raw_os_error),
                    Some(Errno::NOENT | Errno::LOOP | Errno::NOTDIR)
                ) =>
            {
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        if !standing.same(expected)? {
            return Ok(false);
        }
        // Another empty directory can take the name between the check and
        // the removal. The removal takes only an empty directory, so no
        // entry anyone put anywhere is lost.
        match fs::unlinkat(parent.file(), &name, AtFlags::REMOVEDIR) {
            Ok(()) => Ok(true),
            Err(Errno::NOTEMPTY | Errno::EXIST | Errno::NOENT | Errno::NOTDIR) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn rename(
        &self,
        from: &Path,
        to_dir: &Self,
        to: &Path,
        no_replace: bool,
    ) -> io::Result<()> {
        let (from_dir, from) = self.parent(from, false)?;
        let (to_dir, to) = to_dir.parent(to, false)?;
        if no_replace {
            #[cfg(any(
                target_vendor = "apple",
                target_os = "linux",
                target_os = "android",
                target_os = "redox"
            ))]
            return fs::renameat_with(
                from_dir.file(),
                &from,
                to_dir.file(),
                &to,
                fs::RenameFlags::NOREPLACE,
            )
            .map_err(Into::into);
            #[cfg(not(any(
                target_vendor = "apple",
                target_os = "linux",
                target_os = "android",
                target_os = "redox"
            )))]
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "atomic no-replace rename is unavailable",
            ));
        }
        fs::renameat(from_dir.file(), &from, to_dir.file(), &to).map_err(Into::into)
    }

    pub(crate) fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }

    pub(crate) fn same(&self, other: &Self) -> io::Result<bool> {
        use std::os::unix::fs::MetadataExt;
        let a = self.metadata()?;
        let b = other.metadata()?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino() && a.created().ok() == b.created().ok())
    }
}

fn invalid_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "a directory-relative path must contain only ordinary entry names",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_traverses_parent_components_without_skipping_links() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        std::fs::create_dir(path.join("child")).unwrap();
        std::fs::write(path.join("proof"), b"original").unwrap();
        let witness = Directory::open(&path).unwrap();
        assert_eq!(witness.read(Path::new("proof")).unwrap(), b"original");
        let through_parent = Directory::open(&path.join("child/..")).unwrap();
        assert!(witness.same(&through_parent).unwrap());
        assert_eq!(
            through_parent.read(Path::new("proof")).unwrap(),
            b"original"
        );
        assert!(witness.child(Path::new("child/.."), false).is_err());
        std::os::unix::fs::symlink(path.join("child"), path.join("link")).unwrap();
        assert!(Directory::open(&path.join("link/..")).is_err());
    }

    #[test]
    fn retained_children_ignore_root_replacements_and_refuse_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let path = parent.join("owned");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("proof"), b"original").unwrap();
        let directory = Directory::open(&path).unwrap();
        std::fs::rename(&path, parent.join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("proof"), b"replacement").unwrap();
        assert_eq!(directory.read(Path::new("proof")).unwrap(), b"original");
        std::os::unix::fs::symlink(&path, parent.join("linked")).unwrap();
        assert!(Directory::open(&parent.join("linked")).is_err());
        std::os::unix::fs::symlink(&path, parent.join("original/link")).unwrap();
        assert!(directory.read(Path::new("link/proof")).is_err());
        assert!(!directory.same(&Directory::open(&path).unwrap()).unwrap());
    }
    #[test]
    fn a_retained_child_is_cleared_without_removing_its_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let root = Directory::open(&path).unwrap();
        let owned = root.child(Path::new("child/nested"), true).unwrap();
        owned
            .open_file(
                Path::new("proof"),
                OFlags::WRONLY | OFlags::CREATE,
                Mode::from_raw_mode(0o600),
            )
            .unwrap();
        assert_eq!(owned.entries().unwrap(), ["proof"]);
        std::fs::rename(path.join("child"), path.join("original")).unwrap();
        std::fs::create_dir_all(path.join("child/nested")).unwrap();
        std::fs::write(path.join("child/nested/proof"), b"replacement").unwrap();
        owned.clear().unwrap();
        assert!(owned.entries().unwrap().is_empty());
        assert!(path.join("original/nested").is_dir());
        assert_eq!(
            std::fs::read(path.join("child/nested/proof")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn a_made_directory_is_taken_back_only_while_it_stands_empty_at_its_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let root = Directory::open(&path).unwrap();
        std::fs::create_dir(path.join("before")).unwrap();
        let mut made = Vec::new();
        root.child_recorded(Path::new("before/one/two"), &mut made)
            .unwrap();
        assert_eq!(
            made.len(),
            2,
            "a directory there before was recorded as made"
        );

        // Holding a file, it stays.
        std::fs::write(path.join("before/one/two/kept"), b"kept").unwrap();
        assert!(!made[1].take_back().unwrap());
        assert_eq!(
            std::fs::read(path.join("before/one/two/kept")).unwrap(),
            b"kept"
        );
        std::fs::remove_file(path.join("before/one/two/kept")).unwrap();

        // Another empty directory, or a link, at its name stays, and so does
        // the directory the link leads to.
        std::fs::rename(path.join("before/one/two"), path.join("moved")).unwrap();
        std::fs::create_dir(path.join("before/one/two")).unwrap();
        assert!(!made[1].take_back().unwrap());
        assert!(path.join("before/one/two").is_dir());
        std::fs::remove_dir(path.join("before/one/two")).unwrap();
        std::os::unix::fs::symlink(path.join("moved"), path.join("before/one/two")).unwrap();
        assert!(!made[1].take_back().unwrap());
        assert!(path.join("moved").is_dir());
        assert!(
            std::fs::symlink_metadata(path.join("before/one/two"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        std::fs::remove_file(path.join("before/one/two")).unwrap();
        std::fs::rename(path.join("moved"), path.join("before/one/two")).unwrap();

        // The witness: standing empty where it was made, each is taken back,
        // last made first, and the directory there before stays.
        assert!(
            !made[0].take_back().unwrap(),
            "a directory holding another was removed"
        );
        for made in made.iter().rev() {
            assert!(made.take_back().unwrap());
        }
        assert_eq!(root.entries().unwrap(), ["before"]);
        assert!(
            root.child(Path::new("before"), false)
                .unwrap()
                .entries()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_unreadable_file_retains_its_identity_without_exposing_bytes() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let root = Directory::open(&path).unwrap();
        std::fs::write(path.join("file"), b"original").unwrap();
        let expected = std::fs::metadata(path.join("file")).unwrap().ino();
        std::fs::set_permissions(path.join("file"), std::fs::Permissions::from_mode(0o0)).unwrap();
        assert!(root.read(Path::new("file")).is_err());
        #[cfg(target_vendor = "apple")]
        assert_eq!(
            root.observed_identity(Path::new("file"))
                .unwrap()
                .unwrap()
                .1,
            expected
        );
        #[cfg(target_os = "linux")]
        {
            let mut captured = root.capture_file(Path::new("file")).unwrap();
            assert_eq!(captured.metadata().unwrap().ino(), expected);
            assert!(captured.read_to_end(&mut Vec::new()).is_err());
        }
        std::fs::set_permissions(path.join("file"), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        assert_eq!(root.read(Path::new("file")).unwrap(), b"original");
    }
}
