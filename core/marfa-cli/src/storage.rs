//! Before the CLI starts a folder's first sync or its watch, it warns once
//! per folder per run when the folder's directory is in cloud-synced or
//! network storage, and goes on. The core says which storage; this says it.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use marfa_core::{Folder, StorageCause};

type Warned = Mutex<Option<HashSet<PathBuf>>>;

static WARNED: Warned = Mutex::new(None);

/// Warns on standard error, once per run for this folder, if its directory
/// sits in cloud-synced or network storage. For a folder just added.
pub fn warn(folder: &Folder) {
    warn_with(
        folder.root(),
        &|| folder.storage_cause(),
        &WARNED,
        &mut std::io::stderr(),
    );
}

/// The same for a folder whose watch has started, where the watch has said
/// already what it found.
pub fn warn_of(dir: &Path, cause: &StorageCause) {
    warn_with(
        dir,
        &|| Some(cause.clone()),
        &WARNED,
        &mut std::io::stderr(),
    );
}

/// The lock is held only to look and to record, never across `cause`, which
/// reads the file system and can wait on a mount that does not answer: one
/// folder's wait must not hold up another's warning. Two callers racing on
/// one folder both ask, and the one that records it prints.
fn warn_with(
    dir: &Path,
    cause: &dyn Fn() -> Option<StorageCause>,
    warned: &Warned,
    out: &mut dyn Write,
) {
    let held = || {
        warned
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    if held().get_or_insert_default().contains(dir) {
        return;
    }
    let Some(cause) = cause() else {
        return;
    };
    let first = held().get_or_insert_default().insert(dir.to_path_buf());
    if first {
        let _ = writeln!(out, "{}", notice(dir, &cause));
    }
}

fn notice(dir: &Path, cause: &StorageCause) -> String {
    let shown = dir.display();
    match cause {
        StorageCause::ICloudDrive => format!(
            "marfa: warning: {shown} is in iCloud Drive, which syncs its files itself, so a second program syncs the same files as Marfa and the two can overwrite each other's changes or leave conflicting copies; Marfa goes on"
        ),
        StorageCause::CloudService => format!(
            "marfa: warning: {shown} is in a location a cloud service syncs itself, so a second program syncs the same files as Marfa and the two can overwrite each other's changes or leave conflicting copies; Marfa goes on"
        ),
        StorageCause::CloudSynced => format!(
            "marfa: warning: {shown} is in a location iCloud Drive or another cloud service syncs itself, so a second program syncs the same files as Marfa and the two can overwrite each other's changes or leave conflicting copies; Marfa goes on"
        ),
        StorageCause::NetworkFileSystem(kind) => format!(
            "marfa: warning: {shown} is on a network file system ({kind}), where a change made from another computer may not be noticed, so a watch can miss it until a later full scan; Marfa goes on"
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    use super::*;

    fn said(dir: &str, cause: Option<StorageCause>) -> String {
        let (warned, mut out) = (Mutex::new(None), Vec::new());
        warn_with(Path::new(dir), &|| cause.clone(), &warned, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn each_cause_is_named_in_one_line_that_names_the_directory() {
        let text = said("/home/notes", Some(StorageCause::ICloudDrive));
        assert!(text.starts_with("marfa: warning: /home/notes is in iCloud Drive"));
        assert_eq!(text.lines().count(), 1, "{text}");
        let text = said("/home/notes", Some(StorageCause::CloudService));
        assert!(
            text.contains("cloud service") && !text.contains("iCloud"),
            "{text}"
        );
        let text = said(
            "/home/notes",
            Some(StorageCause::NetworkFileSystem("nfs".into())),
        );
        assert!(text.contains("network file system (nfs)"), "{text}");
        assert!(text.contains("not be noticed"), "{text}");
        let text = said("/home/notes", Some(StorageCause::CloudSynced));
        assert!(
            text.contains("iCloud Drive or another cloud service"),
            "{text}"
        );
        // The witness: a directory with no cause is said nothing of.
        assert_eq!(said("/home/notes", None), "");
    }

    #[test]
    fn a_folder_is_warned_of_once_per_run_however_often_it_is_asked_about() {
        let (warned, mut out) = (Mutex::new(None), Vec::new());
        let cause = || Some(StorageCause::ICloudDrive);
        for dir in ["/one", "/one", "/two", "/one", "/two"] {
            warn_with(Path::new(dir), &cause, &warned, &mut out);
        }
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 2, "{text}");
        assert!(text.contains("/one") && text.contains("/two"), "{text}");
    }

    #[test]
    fn a_folder_with_no_cause_is_asked_about_again_and_never_recorded() {
        let (warned, mut out) = (Mutex::new(None), Vec::new());
        let asked = std::cell::Cell::new(0);
        let cause = || {
            asked.set(asked.get() + 1);
            None
        };
        warn_with(Path::new("/plain"), &cause, &warned, &mut out);
        warn_with(Path::new("/plain"), &cause, &warned, &mut out);
        assert_eq!(asked.get(), 2);
        assert!(out.is_empty());
    }

    #[test]
    fn a_folder_whose_storage_does_not_answer_holds_up_no_other_folder() {
        let warned = Arc::new(Mutex::new(None));
        let (release, blocked) = mpsc::channel::<()>();
        let (started_tx, started) = mpsc::channel::<()>();
        let slow = {
            let warned = Arc::clone(&warned);
            std::thread::spawn(move || {
                let mut out = Vec::new();
                warn_with(
                    Path::new("/unresponsive"),
                    &|| {
                        started_tx.send(()).unwrap();
                        blocked.recv().unwrap();
                        Some(StorageCause::NetworkFileSystem("nfs".into()))
                    },
                    &warned,
                    &mut out,
                );
                String::from_utf8(out).unwrap()
            })
        };
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        // The first is now inside its classifier. The second must get past
        // the lock and print while the first still waits.
        let (done_tx, done) = mpsc::channel();
        let quick = {
            let warned = Arc::clone(&warned);
            std::thread::spawn(move || {
                let mut out = Vec::new();
                warn_with(
                    Path::new("/other"),
                    &|| Some(StorageCause::ICloudDrive),
                    &warned,
                    &mut out,
                );
                done_tx.send(String::from_utf8(out).unwrap()).unwrap();
            })
        };
        let other = done.recv_timeout(Duration::from_secs(10));
        // Let the first go whatever happened, so the test never hangs.
        release.send(()).unwrap();
        let first = slow.join().unwrap();
        quick.join().unwrap();
        let other = other.expect("a folder's wait on its storage held up another folder's warning");
        assert!(other.contains("/other"), "{other}");
        assert!(first.contains("/unresponsive"), "{first}");
    }

    #[test]
    fn callers_racing_on_one_folder_print_one_warning() {
        let warned = Arc::new(Mutex::new(None));
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (warned, barrier) = (Arc::clone(&warned), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    let mut out = Vec::new();
                    warn_with(
                        Path::new("/raced"),
                        &|| {
                            barrier.wait();
                            Some(StorageCause::CloudService)
                        },
                        &warned,
                        &mut out,
                    );
                    out.len()
                })
            })
            .collect();
        let printed = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|len| *len > 0)
            .count();
        assert_eq!(printed, 1);
    }
}
