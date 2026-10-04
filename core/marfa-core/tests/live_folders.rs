//! A folder's sync and watch against a real server: `MARFA_TEST_URL` and
//! `MARFA_TEST_KEY` name it, `scripts/server-up.sh` provides both. Ignored by
//! default; run with `cargo nextest run -p marfa-core --run-ignored only`.
//! Every folder lists itself in a registry under a temporary directory, never
//! the machine's own.

use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use marfa_core::folder::{REGISTRY_ENV, Registry};
use marfa_core::{CoreError, Folder, Server, SyncReport, Synced, WatchError, WatchEvent};

fn server() -> Server {
    let url = std::env::var("MARFA_TEST_URL").expect("MARFA_TEST_URL names the server");
    let key = std::env::var("MARFA_TEST_KEY").expect("MARFA_TEST_KEY holds a working key");
    Server { url, key }
}

/// A way to the server that can be shut, so a folder bound to it loses the
/// server as it would lose a network: a copy refuses a server other than
/// the one it was hydrated from.
struct Door {
    url: String,
    open: Arc<AtomicBool>,
    held: Arc<Mutex<Vec<TcpStream>>>,
}

impl Door {
    fn new() -> Door {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let target = server()
            .url
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string();
        let open = Arc::new(AtomicBool::new(true));
        let held = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
        let (still, streams) = (Arc::clone(&open), Arc::clone(&held));
        std::thread::spawn(move || {
            // Dropped once shut, so a connection is refused as by a server
            // that is down.
            let listener = listener;
            while still.load(Ordering::SeqCst) {
                let Ok((client, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                };
                client.set_nonblocking(false).unwrap();
                let upstream = TcpStream::connect(&target).unwrap();
                let mut held = streams.lock().unwrap();
                held.push(client.try_clone().unwrap());
                held.push(upstream.try_clone().unwrap());
                for (mut from, mut to) in [
                    (client.try_clone().unwrap(), upstream.try_clone().unwrap()),
                    (upstream, client),
                ] {
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut from, &mut to);
                        let _ = to.shutdown(Shutdown::Both);
                    });
                }
            }
        });
        Door { url, open, held }
    }

    fn server(&self) -> Server {
        Server {
            url: self.url.clone(),
            key: server().key,
        }
    }

    fn shut(&self) {
        self.open.store(false, Ordering::SeqCst);
        for stream in self.held.lock().unwrap().drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        // The accept loop polls every 10 ms.
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Raises a watch's stop when dropped, so a failed assertion ends the
/// watch rather than leaving the test waiting on it.
struct Raise<'a>(&'a AtomicBool);

impl Drop for Raise<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn seed(args: &[&str]) -> String {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/seed.sh");
    let output = Command::new(script)
        .args(args)
        .output()
        .expect("seed.sh runs");
    assert!(
        output.status.success(),
        "seed.sh {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn nonce() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("zq{}{}", now.as_secs(), now.subsec_micros())
}

static REGISTRY: Once = Once::new();

/// Set once, before any folder reads it, so no test races another's write.
fn registry() -> Registry {
    REGISTRY.call_once(|| {
        let dir = tempfile::tempdir().unwrap().keep();
        // SAFETY: under the `Once`, before any thread this file starts reads
        // the environment.
        unsafe { std::env::set_var(REGISTRY_ENV, dir.join("folders.json")) };
    });
    Registry::located().expect("the registry is named")
}

/// A folder of the notes tagged with a tag of its own, so it holds only
/// what the test writes, its first sync already confirmed.
fn added(dir: &Path, through: Server) -> Folder {
    let folder = added_waiting(dir, through);
    folder.confirm_first_sync().unwrap();
    folder
}

/// The same folder with its first sync still waiting.
fn added_waiting(dir: &Path, through: Server) -> Folder {
    registry();
    let tag = nonce();
    let settings = serde_json::json!({
        "search": { "types": ["core.note"], "filter": format!("tags contains \"{tag}\"") },
        "defaults": { "tags": [tag] },
    });
    let id = seed(&["folder", &nonce(), &settings.to_string()]);
    Folder::add(dir, &id, Some(through)).unwrap()
}

/// A sync that ran, not one waiting to be confirmed.
fn ran(folder: &Folder) -> SyncReport {
    match folder.sync().unwrap() {
        Synced::Done(report) => *report,
        Synced::Waiting(plan) => panic!("the first sync waits for confirmation: {plan:?}"),
    }
}

fn note(dir: &Path, name: &str) {
    std::fs::write(
        dir.join(format!("{name}.md")),
        format!("---\ntitle: {name}\n---\nWritten by a test.\n"),
    )
    .unwrap();
}

#[test]
#[ignore = "needs a running server"]
fn a_sync_sends_what_changed_and_writes_back_what_the_server_holds() {
    let dir = tempfile::tempdir().unwrap();
    let folder = added(dir.path(), server());
    note(dir.path(), "First");
    let synced = ran(&folder);
    assert!(synced.hydrated.is_some(), "a new folder hydrates first");
    assert_eq!(synced.scan.created, 1, "{:?}", synced.scan);
    assert!(synced.drain.report.answered >= 1, "{:?}", synced.drain);
    assert!(synced.catch_up.is_ok(), "{:?}", synced.catch_up);
    assert!(synced.pull.is_some());

    let again = ran(&folder);
    assert!(again.hydrated.is_none());
    assert_eq!(
        (again.scan.created, again.scan.updated, again.scan.unchanged),
        (0, 0, 1)
    );
    let status = Folder::status_of(dir.path()).unwrap();
    assert!(
        status.files.iter().all(|file| file.status == "in_step"),
        "{status:?}"
    );
}

#[test]
#[ignore = "needs a running server"]
fn a_sync_with_the_server_out_of_reach_says_why_and_keeps_the_write() {
    let dir = tempfile::tempdir().unwrap();
    let door = Door::new();
    let folder = added(dir.path(), door.server());
    ran(&folder);
    door.shut();
    note(dir.path(), "Offline");
    let synced = ran(&folder);
    assert!(
        matches!(&synced.catch_up, Err(error) if error.is_environmental()),
        "{:?}",
        synced.catch_up
    );
    assert!(
        synced.drain.report.unavailable.is_some(),
        "{:?}",
        synced.drain
    );
    assert_eq!(synced.scan.created, 1);
    let status = Folder::status_of(dir.path()).unwrap();
    assert!(
        status
            .files
            .iter()
            .any(|file| file.path == "Offline.md" && file.status == "waiting"),
        "{status:?}"
    );
}

#[test]
#[ignore = "needs a running server"]
fn a_folder_with_writes_waiting_is_not_removed_and_one_sent_is() {
    let dir = tempfile::tempdir().unwrap();
    let folder = added(dir.path(), server());
    ran(&folder);
    note(dir.path(), "Waiting");
    folder.scan().unwrap();
    drop(folder);
    let refused = Folder::remove_at(dir.path());
    assert!(
        matches!(&refused, Err(CoreError::Invalid(why)) if why.contains("not yet sent")),
        "{refused:?}"
    );
    assert!(dir.path().join(".marfa").exists());

    Folder::open(dir.path(), Some(server()))
        .unwrap()
        .sync()
        .unwrap();
    Folder::remove_at(dir.path()).unwrap();
    assert!(!dir.path().join(".marfa").exists());
    assert!(dir.path().join("Waiting.md").exists(), "its files stay");
    let listed = registry().folders().unwrap();
    assert!(!listed.iter().any(|entry| entry.dir.ends_with(dir.path())));
}

#[test]
#[ignore = "needs a running server"]
fn a_folder_whose_directory_is_gone_is_taken_off_the_registry() {
    let parent = tempfile::tempdir().unwrap();
    let dir = parent.path().join("gone");
    drop(added(&dir, server()));
    let resolved = std::fs::canonicalize(&dir).unwrap();
    // The witness: the registry lists it before the directory goes.
    assert!(
        registry()
            .folders()
            .unwrap()
            .iter()
            .any(|entry| entry.dir == resolved)
    );
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(matches!(
        Folder::status_of(&dir),
        Err(CoreError::Invalid(why)) if why.contains("is not a folder")
    ));
    Folder::remove_at(&dir).unwrap();
    assert!(
        !registry()
            .folders()
            .unwrap()
            .iter()
            .any(|entry| entry.dir == resolved)
    );
}

#[test]
#[ignore = "needs a running server"]
fn a_watch_holds_its_folder_until_its_stop_and_then_lets_it_go() {
    let dir = tempfile::tempdir().unwrap();
    let folder = added(dir.path(), server());
    let stop = AtomicBool::new(false);
    let (told, events) = mpsc::channel::<WatchEvent>();
    let watched = std::thread::scope(|scope| {
        let raise = Raise(&stop);
        let watch = scope.spawn(|| {
            folder.watch(&stop, |event| {
                let _ = told.send(event);
                Ok::<(), ()>(())
            })
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        let wait_for = |what: &str, found: &dyn Fn(&WatchEvent) -> bool| loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match events.recv_timeout(left) {
                Ok(event) if found(&event) => return event,
                Ok(_) => {}
                Err(_) => panic!("the watch never told {what}"),
            }
        };
        wait_for("that it watches", &|event| {
            matches!(event, WatchEvent::Watching { .. })
        });
        assert!(
            matches!(
                Folder::open(dir.path(), None),
                Err(CoreError::ReadingHandle)
            ),
            "a second opener was handed the folder the watch holds"
        );
        note(dir.path(), "Watched");
        wait_for(
            "a pass that sent the new file",
            &|event| matches!(event, WatchEvent::Passed(pass) if pass.scan.created == 1 && pass.drain.report.answered >= 1),
        );
        let status = Folder::status_of(dir.path());
        assert!(
            status.is_ok(),
            "status did not answer beside a watch: {status:?}"
        );
        drop(raise);
        let stopped = Instant::now();
        let watched = watch.join().unwrap();
        assert!(
            stopped.elapsed() < Duration::from_secs(10),
            "the watch took {:?} to end after its stop",
            stopped.elapsed()
        );
        watched
    });
    assert!(watched.is_ok(), "{watched:?}");
    drop(folder);
    Folder::open(dir.path(), None).expect("the watch let the folder go");
}

#[test]
#[ignore = "needs a running server"]
fn a_stop_raised_during_a_pass_ends_the_watch_once_that_pass_is_done() {
    let dir = tempfile::tempdir().unwrap();
    let door = Door::new();
    let folder = added(dir.path(), door.server());
    ran(&folder);
    // Out of reach, so the write the pass queues stays queued.
    door.shut();
    note(dir.path(), "Mid");
    let stop = AtomicBool::new(false);
    let mut passes = 0;
    let watched = folder.watch(&stop, |event| {
        // Told from inside the pass, before it returns.
        if let WatchEvent::Passed(pass) = &event {
            passes += 1;
            assert_eq!(pass.scan.created, 1, "{:?}", pass.scan);
            stop.store(true, Ordering::SeqCst);
        }
        Ok::<(), ()>(())
    });
    assert!(watched.is_ok(), "{watched:?}");
    assert_eq!(passes, 1, "a pass ran after the stop");
    let status = Folder::status_of(dir.path()).unwrap();
    assert!(
        status
            .files
            .iter()
            .any(|file| file.path == "Mid.md" && file.status == "waiting"),
        "the write the stopped watch queued is kept: {status:?}"
    );
}

#[test]
#[ignore = "needs a running server"]
fn a_watch_whose_tell_fails_ends_with_that_failure() {
    let dir = tempfile::tempdir().unwrap();
    let folder = added(dir.path(), server());
    let stop = AtomicBool::new(false);
    let watched = folder.watch(&stop, |_| Err("the caller went away"));
    assert!(
        matches!(watched, Err(WatchError::Told("the caller went away"))),
        "{watched:?}"
    );
}

#[test]
#[ignore = "needs a running server"]
fn a_watch_whose_tell_panics_ends_and_lets_the_folder_go() {
    let dir = tempfile::tempdir().unwrap();
    let folder = added(dir.path(), server());
    ran(&folder);
    let (done, ended) = mpsc::channel();
    std::thread::spawn(move || {
        let stop = AtomicBool::new(false);
        let watched = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            folder.watch(&stop, |_| -> Result<(), ()> {
                panic!("the caller faulted")
            })
        }));
        drop(folder);
        let _ = done.send(watched.is_err());
    });
    let panicked = ended
        .recv_timeout(Duration::from_secs(30))
        .expect("a watch whose tell panicked never ended, and holds its folder");
    assert!(panicked, "the panic did not reach the caller");
    Folder::open(dir.path(), None).expect("the watch let the folder go");
}
