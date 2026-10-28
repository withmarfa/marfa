//! A folder a watch let go to a command, taken back once the command ends.
//! The command line's watch and a watch an app runs through a binding share
//! it, so each takes a folder back the same way.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::registry::Registry;
use super::watch::WatchError;
use super::{Folder, RETRY_HANDED, handover};
use crate::Result;
use crate::error::CoreError;
use crate::priority::lowered;

/// How often the stop is looked at while the next try waits.
const POLL: Duration = Duration::from_millis(100);

/// What became of a folder a watch let go.
pub enum TakeBack {
    /// The folder, opened again. `held` says that another process, with no
    /// command asking for it, kept the folder past [`HANDOVER_WAIT`] first.
    ///
    /// [`HANDOVER_WAIT`]: super::HANDOVER_WAIT
    Folder { folder: Box<Folder>, held: bool },
    /// The watch was stopped while the folder was away.
    Stopped,
    /// The command removed the folder's state.
    Removed,
    /// The command took the folder off the registry and left its state.
    Unlisted,
}

/// How long each wait lasts.
#[derive(Clone, Copy)]
struct Timing {
    /// Between two tries to open the folder again.
    retry: Duration,
    /// The folder is another process's once no command has asked for it
    /// this long.
    held: Duration,
}

impl Folder {
    /// Whether the machine's registry lists the folder at `root`; `None`
    /// where there is no registry or it cannot be read. Read before a folder
    /// is let go, it is what [`Folder::take_back`] compares the registry with
    /// to see that a command took the folder off it.
    pub fn listed_at(root: &Path) -> Option<bool> {
        let registry = Registry::located()?;
        let entries = registry.read().ok()??;
        Some(entries.iter().any(|entry| entry.dir == root))
    }

    /// The folder at `root`, which a watch let go to a command, once that
    /// command lets it go: tried every [`RETRY_HANDED`] through `reopen`,
    /// which must not ask for the folder. A folder some process holds with no
    /// command asking for it for longer than a command waits is another
    /// process's, and `held_elsewhere` is called once for it; the folder is
    /// tried on until that process lets it go. A failure of the machine for a
    /// moment is tried again; any other ends the wait.
    ///
    /// `listed_before` is [`Folder::listed_at`] as it stood before the folder
    /// was let go. Opened, a folder would be listed again, so one a command
    /// took off the registry is not opened.
    ///
    /// On Apple platforms the calling thread runs at utility quality of
    /// service until this returns, as the watch it belongs to does.
    pub fn take_back<E>(
        root: &Path,
        listed_before: Option<bool>,
        stop: &AtomicBool,
        reopen: impl FnMut() -> Result<Folder>,
        held_elsewhere: impl FnMut() -> std::result::Result<(), E>,
    ) -> std::result::Result<TakeBack, WatchError<E>> {
        let _lowered = lowered();
        taking_back(
            root,
            listed_before,
            stop,
            Timing {
                retry: RETRY_HANDED,
                held: handover::HANDOVER_WAIT,
            },
            Folder::listed_at,
            reopen,
            held_elsewhere,
        )
    }
}

fn taking_back<E>(
    root: &Path,
    listed_before: Option<bool>,
    stop: &AtomicBool,
    timing: Timing,
    listed: impl Fn(&Path) -> Option<bool>,
    mut reopen: impl FnMut() -> Result<Folder>,
    mut held_elsewhere: impl FnMut() -> std::result::Result<(), E>,
) -> std::result::Result<TakeBack, WatchError<E>> {
    let mut asked_at = crate::clock::now();
    let mut held = false;
    loop {
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "folder-take-back-wait");
        crate::clock::wait(stop, timing.retry, POLL.min(timing.retry));
        if stop.load(Ordering::SeqCst) {
            return Ok(TakeBack::Stopped);
        }
        if !Folder::is_at(root) {
            return Ok(TakeBack::Removed);
        }
        if listed_before == Some(true) && listed(root) == Some(false) {
            return Ok(TakeBack::Unlisted);
        }
        if Folder::asked_at(root) {
            asked_at = crate::clock::now();
            continue;
        }
        match reopen() {
            Ok(folder) => {
                return Ok(TakeBack::Folder {
                    folder: Box::new(folder),
                    held,
                });
            }
            Err(CoreError::ReadingHandle) => {
                if !held && crate::clock::now().saturating_duration_since(asked_at) >= timing.held {
                    held = true;
                    held_elsewhere().map_err(WatchError::Told)?;
                }
            }
            Err(error) if error.is_environmental() => {}
            Err(error) => return Err(WatchError::Core(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::directory::Directory;
    use crate::directory_vfs::DirectoryVfs;
    use crate::folder::STATE_DIR;
    use crate::lock::{Handle, WriterLock};

    const QUICK: Timing = Timing {
        retry: Duration::from_millis(20),
        held: Duration::from_millis(200),
    };

    fn bound_folder() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = temp.path().join("notes");
        std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
        let core = crate::Core::open(dir.join(STATE_DIR).join("core.sqlite"), None).unwrap();
        crate::folder::settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        (temp, dir)
    }

    fn take(
        dir: &Path,
        listed: impl Fn(&Path) -> Option<bool>,
        stop: &AtomicBool,
        mut held_elsewhere: impl FnMut(),
    ) -> std::result::Result<TakeBack, WatchError<()>> {
        taking_back(
            dir,
            Some(true),
            stop,
            QUICK,
            listed,
            || Folder::open(dir, None),
            || {
                held_elsewhere();
                Ok(())
            },
        )
    }

    /// Asks for the folder at `dir`, as a command waiting for it does.
    fn asking(dir: &Path) -> WriterLock {
        let state = Directory::open(&dir.join(STATE_DIR)).unwrap();
        let vfs = DirectoryVfs::new(state.file()).unwrap();
        let request = WriterLock::claim_named(&vfs, handover::REQUEST_LOCK, true).unwrap();
        assert_eq!(request.handle(), Handle::Writer);
        request
    }

    #[test]
    fn a_folder_no_command_works_is_opened_again() {
        let (_temp, dir) = bound_folder();
        let taken = take(&dir, |_| Some(true), &AtomicBool::new(false), || {}).unwrap();
        assert!(matches!(
            taken,
            TakeBack::Folder {
                held: false,
                ref folder
            } if folder.root() == dir.as_path()
        ));
    }

    #[test]
    fn a_folder_a_command_asks_for_is_not_opened_until_the_command_ends() {
        let (_temp, dir) = bound_folder();
        let request = asking(&dir);
        let opens = AtomicUsize::new(0);
        let ended = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let taking = scope.spawn(|| {
                taking_back(
                    &dir,
                    Some(true),
                    &AtomicBool::new(false),
                    QUICK,
                    |_| Some(true),
                    || {
                        opens.fetch_add(1, Ordering::SeqCst);
                        assert!(ended.load(Ordering::SeqCst), "opened while a command asked");
                        Folder::open(&dir, None)
                    },
                    || Ok::<(), ()>(()),
                )
            });
            // Longer than a folder is kept before it is called another
            // process's: a command asking for it is not another process.
            std::thread::sleep(3 * QUICK.held);
            ended.store(true, Ordering::SeqCst);
            drop(request);
            let taken = taking.join().unwrap().unwrap();
            assert!(matches!(taken, TakeBack::Folder { held: false, .. }));
        });
        assert_eq!(opens.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_folder_another_process_keeps_is_said_to_be_held_once_and_taken_when_let_go() {
        let (_temp, dir) = bound_folder();
        let keeper = Folder::open(&dir, None).unwrap();
        let said = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let taking = scope.spawn(|| {
                take(
                    &dir,
                    |_| Some(true),
                    &AtomicBool::new(false),
                    || {
                        said.fetch_add(1, Ordering::SeqCst);
                    },
                )
            });
            std::thread::sleep(4 * QUICK.held);
            drop(keeper);
            let taken = taking.join().unwrap().unwrap();
            assert!(matches!(taken, TakeBack::Folder { held: true, .. }));
        });
        assert_eq!(
            said.load(Ordering::SeqCst),
            1,
            "said once, however long it was kept"
        );
    }

    #[test]
    fn a_folder_a_command_removed_is_not_taken_back() {
        let (_temp, dir) = bound_folder();
        Directory::open(&dir)
            .unwrap()
            .child(Path::new(STATE_DIR), false)
            .unwrap()
            .clear()
            .unwrap();
        let taken = take(&dir, |_| Some(true), &AtomicBool::new(false), || {}).unwrap();
        assert!(matches!(taken, TakeBack::Removed));
    }

    #[test]
    fn a_folder_a_command_took_off_the_registry_is_not_taken_back_and_one_never_listed_is() {
        let (_temp, dir) = bound_folder();
        let taken = take(&dir, |_| Some(false), &AtomicBool::new(false), || {}).unwrap();
        assert!(matches!(taken, TakeBack::Unlisted));
        // The witness: the same folder, unlisted before it was let go too,
        // was never the registry's to lose.
        let taken = taking_back(
            &dir,
            Some(false),
            &AtomicBool::new(false),
            QUICK,
            |_| Some(false),
            || Folder::open(&dir, None),
            || Ok::<(), ()>(()),
        )
        .unwrap();
        assert!(matches!(taken, TakeBack::Folder { .. }));
    }

    #[test]
    fn a_stop_ends_the_wait_for_a_folder_that_stays_away() {
        let (_temp, dir) = bound_folder();
        let _keeper = Folder::open(&dir, None).unwrap();
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let taking = scope.spawn(|| take(&dir, |_| Some(true), &stop, || {}));
            std::thread::sleep(2 * QUICK.retry);
            stop.store(true, Ordering::SeqCst);
            assert!(matches!(taking.join().unwrap().unwrap(), TakeBack::Stopped));
        });
    }

    #[test]
    fn a_failure_that_will_not_clear_ends_the_wait_with_it() {
        let (_temp, dir) = bound_folder();
        let refused = taking_back(
            &dir,
            Some(true),
            &AtomicBool::new(false),
            QUICK,
            |_| Some(true),
            || Err(CoreError::Store("unreadable".into())),
            || Ok::<(), ()>(()),
        );
        assert!(matches!(
            refused,
            Err(WatchError::Core(CoreError::Store(_)))
        ));
        // The witness: one that can clear is tried again.
        let tries = AtomicUsize::new(0);
        let taken = taking_back(
            &dir,
            Some(true),
            &AtomicBool::new(false),
            QUICK,
            |_| Some(true),
            || {
                if tries.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(CoreError::Network("away".into()))
                } else {
                    Folder::open(&dir, None)
                }
            },
            || Ok::<(), ()>(()),
        )
        .unwrap();
        assert!(matches!(taken, TakeBack::Folder { .. }));
        assert_eq!(tries.load(Ordering::SeqCst), 3);
    }
}
