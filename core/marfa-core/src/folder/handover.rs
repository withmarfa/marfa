//! A command asks a watch for a folder the watch holds. The request is a lock
//! in a file of its own beside the writer lock: a command holds it while it
//! waits, and a watch that finds it held lets the folder go. The kernel drops
//! it when the command ends, however it ends, so a request never outlives the
//! command that made it and a reused process id cannot pass for it.

use std::path::Path;
use std::time::Duration;
#[cfg(any(debug_assertions, test))]
use std::time::Instant;

use crate::Result;
use crate::directory::Directory;
use crate::directory_vfs::DirectoryVfs;
use crate::error::CoreError;
use crate::lock::{DIRECTORY_LOCK, Handle, WriterLock};

/// The request's file in a folder's state directory.
pub(crate) const REQUEST_LOCK: &str = "core.sqlite.handover-lock";

/// How long a command waits for the process holding a folder to let it go.
/// A watch lets go at the end of the step of its pass under way, which a
/// slow server can make longer than this.
pub const HANDOVER_WAIT: Duration = Duration::from_secs(10);

const POLL: Duration = Duration::from_millis(50);

/// How often a watch looks for a request.
pub(crate) const LOOK: Duration = Duration::from_millis(200);

/// The writer lock of the store in `state`. Where another process holds it,
/// asks that process to let it go and waits up to `wait` for it; past that,
/// refuses with `ReadingHandle`. The request is held with the lock, until it
/// is dropped, so a watch the folder was let go to sees the command still
/// working it. Without `create_lock`, refuses with `Invalid` where the lock's
/// file goes while it waits, as it does when the holder removed the folder.
/// A request that cannot be made leaves the command waiting all the same, for
/// a holder that ends on its own, and refused past that with the reason.
pub(crate) fn claim_asking(
    state: &Directory,
    root: &Path,
    wait: Duration,
    create_lock: bool,
) -> Result<WriterLock> {
    let vfs = DirectoryVfs::new(state.file())?;
    let lock = WriterLock::claim_directory(&vfs)?;
    if lock.handle() == Handle::Writer {
        return Ok(lock);
    }
    drop(lock);
    let deadline = crate::clock::now() + wait;
    let mut request: Option<WriterLock> = None;
    let mut unmade: Option<CoreError> = None;
    loop {
        if request.is_none() {
            match WriterLock::claim_named(&vfs, REQUEST_LOCK, true) {
                Ok(claimed) if claimed.handle() == Handle::Writer => {
                    request = Some(claimed);
                    unmade = None;
                }
                Ok(_) => {}
                Err(error) => unmade = Some(error),
            }
        }
        // Not created by a command: a folder removed while this waited has
        // no lock file, and making one would leave state in a directory that
        // is no longer a folder.
        match WriterLock::claim_named(&vfs, DIRECTORY_LOCK, create_lock) {
            Ok(lock) if lock.handle() == Handle::Writer => {
                return Ok(match request {
                    Some(request) => lock.holding(request),
                    None => lock,
                });
            }
            Ok(_) => {}
            Err(_) if state.entry_identity(Path::new(DIRECTORY_LOCK)).is_err() => {
                return Err(super::not_a_folder(root));
            }
            Err(error) => return Err(error),
        }
        if crate::clock::now() >= deadline {
            return Err(match unmade {
                Some(error) => unasked(root, error),
                None => CoreError::ReadingHandle,
            });
        }
        #[cfg(debug_assertions)]
        crate::fault::hold(|| "folder-handover-wait");
        crate::clock::wait(&std::sync::atomic::AtomicBool::new(false), POLL, POLL);
    }
}

/// What a caller that did not ask for a folder is told when another process
/// holds it. The command line and a binding both say it.
pub fn held_by_another(root: &Path) -> String {
    format!(
        "{} is being worked by another process, such as a running watch; one process works a folder at a time, so stop it and try again",
        root.display()
    )
}

/// What a caller that asked for a folder is told when the process holding it
/// did not let it go within [`HANDOVER_WAIT`].
pub fn not_handed_over(root: &Path) -> String {
    format!(
        "{} is held by another process, which did not let it go within {} seconds of being asked; a watch lets a folder go when asked, unless it is stopped or a step of its pass takes longer than that, and any other process holds a folder until it ends, so try again once it does",
        root.display(),
        HANDOVER_WAIT.as_secs()
    )
}

/// Why a command that could not ask for a folder is refused, keeping the kind
/// of the failure that kept it from asking.
fn unasked(root: &Path, error: CoreError) -> CoreError {
    let why = format!(
        "{} is held by another process, which could not be asked to let it go, because the request file {} could not be made: {error}",
        root.display(),
        root.join(super::STATE_DIR).join(REQUEST_LOCK).display()
    );
    match error {
        CoreError::StorageFull(_) => CoreError::StorageFull(why),
        _ => CoreError::Store(why),
    }
}

/// Holds a folder opened by asking until a fixture releases its gate, or for
/// the milliseconds the fault names, to observe the watch while it is let go.
pub(crate) fn hold_if_asked() {
    #[cfg(debug_assertions)]
    crate::fault::hold(|| "folder-handed-over");
    #[cfg(debug_assertions)]
    if let Some(gate) = crate::fault::named("gate-handed-folder") {
        std::fs::write(format!("{gate}.ready"), b"").expect("write handover gate readiness");
        let deadline = Instant::now() + Duration::from_secs(60);
        while !Path::new(&format!("{gate}.release")).exists() {
            assert!(Instant::now() < deadline, "handover gate was not released");
            std::thread::sleep(POLL);
        }
    }
    if let Some(millis) =
        crate::fault::named("hold-handed-folder").and_then(|millis| millis.parse::<u64>().ok())
    {
        std::thread::sleep(Duration::from_millis(millis));
    }
}

/// Whether a command waits for the folder whose state is in `state`.
pub(crate) struct Requests {
    vfs: Option<DirectoryVfs>,
    state: Directory,
}

impl Requests {
    pub(crate) fn of(state: &Directory) -> Requests {
        Requests {
            vfs: DirectoryVfs::new(state.file()).ok(),
            state: state.clone(),
        }
    }

    /// A request file no command has made yet is no request, and is not
    /// made here: a folder removed meanwhile keeps no state.
    pub(crate) fn asked(&mut self) -> bool {
        if self.vfs.is_none() {
            self.vfs = DirectoryVfs::new(self.state.file()).ok();
        }
        let Some(vfs) = &self.vfs else {
            return false;
        };
        WriterLock::held_named(vfs, REQUEST_LOCK).unwrap_or(false)
    }
}

/// Whether a command asks for, or works, the folder whose state is in
/// `state`.
pub(crate) fn asked_at(state: &Directory) -> bool {
    Requests::of(state).asked()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    use super::*;

    fn state() -> (tempfile::TempDir, Directory) {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = Directory::open(temp.path()).unwrap();
        (temp, state)
    }

    fn holder(state: &Directory) -> WriterLock {
        let lock = crate::Core::claim_directory(state).unwrap();
        assert_eq!(lock.handle(), Handle::Writer);
        lock
    }

    #[test]
    fn a_shared_probe_is_no_request_and_an_exclusive_command_is() {
        let (_temp, state) = state();
        let vfs = DirectoryVfs::new(state.file()).unwrap();
        drop(WriterLock::claim_named(&vfs, REQUEST_LOCK, true).unwrap());
        let probe = vfs
            .open(REQUEST_LOCK, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
        probe
            .execute_batch("BEGIN; SELECT count(*) FROM sqlite_schema")
            .unwrap();
        let mut requests = Requests::of(&state);
        assert!(!requests.asked(), "a shared observer is not a command");
        drop(probe);
        let command = WriterLock::claim_named(&vfs, REQUEST_LOCK, true).unwrap();
        assert_eq!(command.handle(), Handle::Writer);
        assert!(requests.asked(), "an exclusive command must be seen");
        drop(command);
        assert!(!requests.asked(), "the command's request ended");
    }

    #[test]
    fn observers_never_ask_each_other_for_the_folder() {
        let (_temp, state) = state();
        let vfs = DirectoryVfs::new(state.file()).unwrap();
        drop(WriterLock::claim_named(&vfs, REQUEST_LOCK, true).unwrap());
        let start = Barrier::new(2);
        let false_requests = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    let mut requests = Requests::of(&state);
                    start.wait();
                    for _ in 0..1_000 {
                        if requests.asked() {
                            false_requests.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
            }
        });
        assert_eq!(
            false_requests.load(Ordering::SeqCst),
            0,
            "observers saw requests without any command"
        );
    }

    #[test]
    fn a_free_folder_is_claimed_at_once_and_no_request_is_made() {
        let (temp, state) = state();
        let lock = claim_asking(&state, temp.path(), Duration::ZERO, false).unwrap();
        assert_eq!(lock.handle(), Handle::Writer);
        assert!(!temp.path().join(REQUEST_LOCK).exists());
    }

    #[test]
    fn a_holder_that_lets_go_when_asked_hands_the_folder_over() {
        let (temp, state) = state();
        let held = holder(&state);
        let mut requests = Requests::of(&state);
        // The witness: no request before one is made.
        assert!(!requests.asked());
        std::thread::scope(|scope| {
            let asking =
                scope.spawn(|| claim_asking(&state, temp.path(), Duration::from_secs(10), false));
            let bound = Instant::now() + Duration::from_secs(5);
            while !requests.asked() {
                assert!(Instant::now() < bound, "the request was never seen");
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(held);
            let lock = asking.join().unwrap().unwrap();
            assert_eq!(lock.handle(), Handle::Writer);
            // While it works the folder, the watch sees it there.
            assert!(requests.asked(), "the request ended before the work");
            drop(lock);
            assert!(!requests.asked(), "the request outlived the command");
        });
    }

    #[test]
    fn a_holder_that_does_not_let_go_leaves_the_command_refused_after_the_wait() {
        let (temp, state) = state();
        let _held = holder(&state);
        let started = Instant::now();
        let refused = claim_asking(&state, temp.path(), Duration::from_millis(300), false);
        assert_eq!(refused.err(), Some(CoreError::ReadingHandle));
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(
            !Requests::of(&state).asked(),
            "a command that gave up left its request standing"
        );
    }

    #[test]
    fn a_request_that_cannot_be_made_refuses_after_the_wait_naming_why() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, state) = state();
        let held = holder(&state);
        let readable = |mode| {
            std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(mode)).unwrap();
        };
        readable(0o555);
        let refused = claim_asking(&state, temp.path(), Duration::from_millis(300), false);
        readable(0o755);
        drop(held);
        let Err(CoreError::Store(message)) = &refused else {
            panic!("{:?}", refused.err());
        };
        assert!(
            message.contains("could not be asked to let it go"),
            "{message}"
        );
        assert!(message.contains(REQUEST_LOCK), "{message}");
        // The witness: with the request made, the same holder is asked.
        let _held = holder(&state);
        assert_eq!(
            claim_asking(&state, temp.path(), Duration::from_millis(300), false).err(),
            Some(CoreError::ReadingHandle)
        );
    }

    #[test]
    fn a_request_whose_asker_ended_is_no_request() {
        let (_temp, state) = state();
        let vfs = DirectoryVfs::new(state.file()).unwrap();
        let request = WriterLock::claim_named(&vfs, REQUEST_LOCK, true).unwrap();
        assert!(asked_at(&state));
        // Its connection closing is what the kernel does for a process that
        // ends, however it ends.
        drop(request);
        assert!(!asked_at(&state));
        assert!(
            _temp.path().join(REQUEST_LOCK).exists(),
            "the file stays; only its lock says whether someone asks"
        );
    }

    #[test]
    fn of_two_commands_asking_at_once_one_holds_the_folder_at_a_time() {
        let (temp, state) = state();
        let held = holder(&state);
        let holding = AtomicUsize::new(0);
        let both = AtomicBool::new(false);
        let worked = AtomicUsize::new(0);
        let start = Arc::new(Barrier::new(3));
        std::thread::scope(|scope| {
            let mut asking = Vec::new();
            for _ in 0..2 {
                let start = Arc::clone(&start);
                let (state, holding, both, worked) = (&state, &holding, &both, &worked);
                let root = temp.path();
                asking.push(scope.spawn(move || {
                    start.wait();
                    let lock = claim_asking(state, root, Duration::from_secs(10), false)?;
                    if holding.fetch_add(1, Ordering::SeqCst) > 0 {
                        both.store(true, Ordering::SeqCst);
                    }
                    std::thread::sleep(Duration::from_millis(200));
                    holding.fetch_sub(1, Ordering::SeqCst);
                    worked.fetch_add(1, Ordering::SeqCst);
                    drop(lock);
                    Ok::<(), CoreError>(())
                }));
            }
            start.wait();
            let mut requests = Requests::of(&state);
            let bound = Instant::now() + Duration::from_secs(5);
            while !requests.asked() {
                assert!(Instant::now() < bound, "the request was never seen");
                std::thread::sleep(Duration::from_millis(5));
            }
            drop(held);
            for asking in asking {
                asking.join().unwrap().unwrap();
            }
        });
        assert!(!both.load(Ordering::SeqCst), "two commands held one folder");
        assert_eq!(worked.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_folder_removed_while_a_command_waits_is_no_folder_and_gets_no_state() {
        let (temp, state) = state();
        let held = holder(&state);
        std::thread::scope(|scope| {
            let asking =
                scope.spawn(|| claim_asking(&state, temp.path(), Duration::from_secs(10), false));
            let mut requests = Requests::of(&state);
            while !requests.asked() {
                std::thread::sleep(Duration::from_millis(5));
            }
            // The holder removes the folder's state, as `folders remove` does.
            state.clear().unwrap();
            drop(held);
            let refused = asking.join().unwrap();
            assert!(
                matches!(&refused, Err(CoreError::Invalid(message)) if message.contains("is not a folder")),
                "{:?}",
                refused.err()
            );
        });
        assert!(
            !temp.path().join(DIRECTORY_LOCK).exists(),
            "a command made state in a folder that was removed"
        );
    }
}
