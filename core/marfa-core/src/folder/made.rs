//! What a folder add made, so an add that fails takes back exactly that and
//! keeps whatever was there before it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::directory::{Directory, FileType, MadeDirectory};
use crate::lock::{DIRECTORY_LOCK, Handle, WriterLock};

#[derive(Default)]
pub(super) struct Made {
    /// First made first.
    pub(super) directories: Vec<MadeDirectory>,
    /// The state directory and every entry it held before the add, where it
    /// held no store. Unset, nothing in it is removed.
    state: Option<(Directory, HashSet<PathBuf>)>,
    /// The store's writer lock, from the moment the add claimed it.
    pub(super) lock: Option<Arc<WriterLock>>,
}

impl Made {
    /// Notes what `state` holds before the add puts a store in it. A store
    /// already there is the folder's, with files only SQLite can account
    /// for, so a failed add removes nothing from it. Called once the add holds
    /// the store's writer lock, so no other add can make a store between
    /// this look and the take-back; `lock_there` says whether the lock's
    /// own file existed before the add claimed it.
    pub(super) fn holding(&mut self, state: &Directory, lock_there: bool) {
        let store = state.entry_kind(Path::new("core.sqlite"));
        if !matches!(&store, Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
            return;
        }
        if let Ok(mut held) = inventory(state) {
            if !lock_there {
                held.remove(Path::new(DIRECTORY_LOCK));
            }
            self.state = Some((state.clone(), held));
        }
    }

    /// Removes what the add made once its store is closed: under the
    /// store's writer lock, each entry the state directory did not hold
    /// before, the lock's own file last; then each directory the add made,
    /// last made first, where it still stands empty. The lock is held from
    /// the add's claim to here, so a store another add made in the same
    /// directory is never taken for this one's. What cannot be removed
    /// stays, since the caller reports the add's own failure.
    pub(super) fn take_back(self) {
        let Made {
            directories,
            state,
            lock,
        } = self;
        if let (Some((state, held)), Some(lock)) = (&state, &lock)
            && lock.handle() == Handle::Writer
            && remove_new(state, Path::new(""), held).is_ok()
            && !held.contains(Path::new(DIRECTORY_LOCK))
        {
            let _ = state.unlink(Path::new(DIRECTORY_LOCK));
        }
        drop(lock);
        for made in directories.iter().rev() {
            let _ = made.take_back();
        }
    }
}

/// Every entry below `directory`, by its path inside it, read without
/// following a link.
fn inventory(directory: &Directory) -> std::io::Result<HashSet<PathBuf>> {
    let mut held = HashSet::new();
    let mut pending = vec![(directory.clone(), PathBuf::new())];
    while let Some((directory, at)) = pending.pop() {
        for name in directory.entries()? {
            let name = Path::new(&name);
            if directory.entry_kind(name)? == FileType::Directory {
                pending.push((directory.child(name, false)?, at.join(name)));
            }
            held.insert(at.join(name));
        }
    }
    Ok(held)
}

/// Removes every entry below `directory`, which sits at `at` in the state
/// directory, that `held` does not name, but the writer lock's file.
fn remove_new(directory: &Directory, at: &Path, held: &HashSet<PathBuf>) -> std::io::Result<()> {
    for name in directory.entries()? {
        let name = Path::new(&name);
        let path = at.join(name);
        if path == Path::new(DIRECTORY_LOCK) {
            continue;
        }
        if directory.entry_kind(name)? == FileType::Directory {
            let child = directory.child(name, false)?;
            remove_new(&child, &path, held)?;
            if !held.contains(&path) {
                directory.remove_dir(name, &child)?;
            }
        } else if !held.contains(&path) {
            directory.unlink(name)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_another_add_holds_is_not_taken_back() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = temp.path().join(super::super::STATE_DIR);
        std::fs::create_dir(&path).unwrap();
        let state = Directory::open(&path).unwrap();
        let mut made = Made::default();
        made.holding(&state, false);
        // Another add makes its store here after this one looked, and holds
        // it while this one fails.
        let holder = crate::Core::open_directory(&state, &path.join("core.sqlite"), None).unwrap();
        made.lock = Some(Arc::new(crate::Core::claim_directory(&state).unwrap()));
        assert_eq!(made.lock.as_ref().unwrap().handle(), Handle::Reader);
        made.take_back();
        assert!(path.join("core.sqlite").is_file());
        assert!(path.join(DIRECTORY_LOCK).is_file());
        drop(holder);

        // The witness: holding the lock itself, a failed add removes what
        // the directory did not hold before.
        let made = Made {
            state: Some((state.clone(), HashSet::new())),
            lock: Some(Arc::new(crate::Core::claim_directory(&state).unwrap())),
            ..Made::default()
        };
        assert_eq!(made.lock.as_ref().unwrap().handle(), Handle::Writer);
        made.take_back();
        assert!(state.entries().unwrap().is_empty(), "{:?}", state.entries());
    }

    #[test]
    fn a_store_another_add_made_and_released_first_is_not_taken_back() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = temp.path().join(super::super::STATE_DIR);
        std::fs::create_dir(&path).unwrap();
        let state = Directory::open(&path).unwrap();
        // Another add makes its store here and lets it go before this one
        // claims the lock; this one is then refused.
        drop(crate::Core::open_directory(&state, &path.join("core.sqlite"), None).unwrap());
        let mut made = Made::default();
        let lock_there = state.entry_kind(Path::new(DIRECTORY_LOCK)).is_ok();
        made.lock = Some(Arc::new(crate::Core::claim_directory(&state).unwrap()));
        made.holding(&state, lock_there);
        made.take_back();
        assert!(path.join("core.sqlite").exists());
    }
}
