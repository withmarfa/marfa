//! A folder's store that another build of the core made. Where it holds no
//! write the server has not taken, the store is only a copy of the server's
//! rows and a record of which file is which item, and both come back: a
//! hydration fills the copy and the next scan matches each file to its item
//! again by the file's own identity. So a folder's writer replaces it with an
//! empty store of this build's shape, keeping what no hydration brings back
//! (`folders/refused-store-replaced`).

use std::path::Path;
use std::sync::Arc;

use super::{elsewhere, first, placement, settings_file};
use crate::directory::Directory;
use crate::lock::WriterLock;
use crate::{Core, CoreError, Handle, Result, Server, store};

/// What the folder records of itself in its store's meta that no hydration
/// brings back: the `system.folder` it follows, whether its first sync
/// waits, the settings file it last wrote, the placements the server
/// refused, and how the folder registry knows its store. The server it
/// was hydrated from too, so the new store is filled from the same instance
/// (`folders/refused-store-kept`).
const CARRIED: &[&str] = &[
    settings_file::META_FOLDER,
    settings_file::META_WRITTEN,
    settings_file::META_WRITTEN_VERSION,
    settings_file::META_REFUSED,
    settings_file::META_LANDING,
    first::META_FIRST_SYNC,
    placement::META_REFUSED,
    elsewhere::META_STORE,
    elsewhere::META_LISTED_IN,
    elsewhere::META_OTHERS,
    store::META_SERVER_ORIGIN,
    store::META_INSTANCE_ID,
];

/// Opens the folder's store in `state` under `lock`. A store this build
/// refuses `wrong_schema` that holds no write the server has not taken is
/// replaced first, where `lock` is the writer's, and the reason it was
/// refused is answered with the store.
pub(super) fn opened(
    state: &Directory,
    label: &Path,
    server: Option<Server>,
    lock: Arc<WriterLock>,
) -> Result<(Core, Option<String>)> {
    let (path, reason) = match Core::open_claimed(state, label, server.clone(), Arc::clone(&lock)) {
        Ok(core) => return Ok((core, None)),
        Err(CoreError::WrongSchema {
            path,
            reason,
            unsent: Some(0),
            ..
        }) if lock.handle() == Handle::Writer => (path, reason),
        Err(error) => return Err(error),
    };
    // Only a folder's own store is replaced: one that names no folder stays
    // refused.
    let names_folder = {
        let vfs = crate::directory_vfs::DirectoryVfs::new(state.file())?;
        store::refused_folder_meta(&vfs, &[settings_file::META_FOLDER])?
            .contains_key(settings_file::META_FOLDER)
    };
    if !names_folder {
        return Err(CoreError::WrongSchema {
            path,
            reason,
            unsent: Some(0),
            folder: true,
        });
    }
    store::replace_folder_store(state, label, CARRIED)?;
    let core = Core::open_claimed(state, label, server, lock)?;
    Ok((core, Some(reason)))
}

/// The origin the folder's store was hydrated from and whether its first
/// sync waits, read from a store this build refuses `wrong_schema` while it
/// holds no write the server has not taken, which the folder's writer
/// replaces on open.
pub(super) fn recorded(state: &Directory) -> Result<(Option<String>, bool)> {
    let vfs = crate::directory_vfs::DirectoryVfs::new(state.file())?;
    let mut held =
        store::refused_folder_meta(&vfs, &[store::META_SERVER_ORIGIN, first::META_FIRST_SYNC])?;
    Ok((
        held.remove(store::META_SERVER_ORIGIN),
        held.contains_key(first::META_FIRST_SYNC),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::super::{Folder, STATE_DIR, settings_file};
    use crate::{Core, CoreError, store};

    const FOLDER: &str = "01a00000-0000-7000-8000-000000000001";
    const ORIGIN: &str = "https://marfa.example";

    /// A folder whose store another build of the core made: a column this
    /// build does not make. `bound` names the folder in it.
    fn refused_folder(bound: bool) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let path = state.join(store::FOLDER_STORE);
        let core = Core::open(&path, None).unwrap();
        store::meta_set(&core.conn().unwrap(), store::META_SERVER_ORIGIN, ORIGIN).unwrap();
        if bound {
            settings_file::bind(&core, FOLDER).unwrap();
        }
        drop(core);
        if bound {
            Folder::open(dir.path(), None)
                .unwrap()
                .wait_for_confirmation()
                .unwrap();
        }
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("ALTER TABLE items ADD COLUMN stray TEXT")
            .unwrap();
        (dir, path)
    }

    fn stray(path: &Path) -> bool {
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .prepare("SELECT stray FROM items")
            .is_ok()
    }

    fn made_left(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir.join(STATE_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(store::FOLDER_STORE_MADE))
            .collect()
    }

    #[test]
    fn a_folder_store_holding_nothing_unsent_is_replaced_keeping_what_the_folder_records() {
        let (dir, path) = refused_folder(true);
        // The witness: this build refuses the store as it is.
        assert!(matches!(
            Core::open(&path, None),
            Err(CoreError::WrongSchema {
                unsent: Some(0),
                ..
            })
        ));

        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(
            folder
                .replaced_store()
                .is_some_and(|reason| reason.contains("items")),
            "{:?}",
            folder.replaced_store()
        );
        assert_eq!(folder.folder_id(), FOLDER);
        assert!(
            folder.awaiting_confirmation().unwrap(),
            "the first sync's wait was dropped"
        );
        assert_eq!(
            store::meta_get(&folder.core().conn().unwrap(), store::META_SERVER_ORIGIN).unwrap(),
            Some(ORIGIN.to_string())
        );
        drop(folder);
        assert!(!stray(&path), "the store another build made was kept");
        assert!(made_left(dir.path()).is_empty());
        assert!(
            Folder::open(dir.path(), None)
                .unwrap()
                .replaced_store()
                .is_none(),
            "a store this build made was replaced"
        );
    }

    #[test]
    fn a_folder_store_that_cannot_be_made_leaves_the_refused_one_where_it_was() {
        let (dir, path) = refused_folder(true);
        let failed = {
            let _fault = crate::fault::fail_on_this_thread("replace-refused-make");
            Folder::open(dir.path(), None)
        };
        assert!(
            matches!(&failed, Err(CoreError::Store(reason)) if reason.contains("cannot be replaced")),
            "{:?}",
            failed.err()
        );
        assert!(stray(&path), "the refused store was not left where it was");
        assert!(
            made_left(dir.path()).is_empty(),
            "{:?}",
            made_left(dir.path())
        );
        assert!(
            Folder::open(dir.path(), None)
                .unwrap()
                .replaced_store()
                .is_some()
        );
    }

    #[test]
    fn a_refused_store_that_names_no_folder_is_refused_as_a_folders_and_left_alone() {
        let (dir, path) = refused_folder(false);
        let before = std::fs::read(&path).unwrap();
        assert!(matches!(
            Folder::open(dir.path(), None),
            Err(CoreError::WrongSchema {
                unsent: Some(0),
                folder: true,
                ..
            })
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(stray(&path));
    }
}
