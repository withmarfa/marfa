use super::*;
use clap::Parser;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Instant;

const BUDGET: Duration = Duration::from_secs(15);

#[test]
fn credential_process_child() {
    let Ok(operation) = std::env::var("MARFA_TEST_CREDENTIAL_OPERATION") else {
        return;
    };
    assert!(std::env::var_os("MARFA_TEST_CREDENTIAL_STORE").is_some());
    let origin = std::env::var("MARFA_TEST_ORIGIN").unwrap();
    if let Some(ready) = std::env::var_os("MARFA_TEST_READY") {
        std::fs::write(&ready, "ready")
            .unwrap_or_else(|error| panic!("{operation} readiness at {ready:?}: {error}"));
    }
    match operation.as_str() {
        "seed" | "seed-no-revoke" | "seed-fresh" => credentials::keep(
            &origin,
            &Kept::Token {
                access_token: "marfa_at_old".into(),
                refresh_token: Some("marfa_rt_old".into()),
                expires_at: (operation != "seed-fresh").then_some(0),
                client_id: "fixture-client".into(),
                scope: None,
                token_endpoint: format!("{origin}/token"),
                revocation_endpoint: (operation == "seed").then(|| format!("{origin}/revoke")),
            },
        )
        .unwrap(),
        "resolve-refresh" => {
            let remote = Remote::resolve(&crate::remote::Named {
                url: Some(origin.clone()),
                key: None,
            })
            .unwrap();
            let kept = credentials::read(&origin).unwrap().unwrap();
            assert!(!is_stale(&kept));
            assert!(remote.bearer().as_deref() == Some(kept.bearer()));
        }
        "resolve" | "resolve-unsafe" | "resolve-corrupt" => {
            let resolved = Remote::resolve(&crate::remote::Named {
                url: Some(origin),
                key: None,
            });
            match operation.as_str() {
                "resolve" => {
                    assert_eq!(resolved.unwrap().bearer().as_deref(), Some("marfa_at_old"))
                }
                "resolve-unsafe" => assert!(matches!(resolved,
                    Err(CliError::Invalid(message)) if message.contains("credential lock"))),
                _ => assert!(matches!(resolved,
                    Err(CliError::Invalid(message)) if message.contains("keychain entry"))),
            }
        }
        "refresh" => {
            let refreshed = refresh(&origin, None).unwrap();
            assert!(!is_stale(&refreshed));
            assert_ne!(refreshed.bearer(), "marfa_at_old");
        }
        "refused" => {
            assert_eq!(
                refresh(&origin, Some("marfa_at_old")).unwrap().bearer(),
                "marfa_at_new"
            );
        }
        "signed-out" => assert!(matches!(
            refresh(&origin, None),
            Err(CliError::SignedOut { .. })
        )),
        "logout-human" => {
            crate::run(crate::Cli::try_parse_from(["marfa", "--url", &origin, "logout"]).unwrap())
                .unwrap();
        }
        "logout" => {
            crate::run(
                crate::Cli::try_parse_from(["marfa", "--url", &origin, "--json", "logout"])
                    .unwrap(),
            )
            .unwrap();
        }
        "forget" => {
            crate::run(
                crate::Cli::try_parse_from([
                    "marfa",
                    "--url",
                    &format!("{origin}/?ignored=yes#fragment"),
                    "--json",
                    "keys",
                    "forget",
                ])
                .unwrap(),
            )
            .unwrap();
        }
        "forget-current" => {
            crate::run(crate::Cli::try_parse_from(["marfa", "--json", "keys", "forget"]).unwrap())
                .unwrap();
        }
        "unsafe-lock" | "safe-lock" => {
            let folder = PathBuf::from(std::env::var_os("MARFA_TEST_CREDENTIAL_STORE").unwrap());
            let outcome = lock_file_in(&folder.parent().unwrap().join("locks"), &origin);
            assert_eq!(outcome.is_ok(), operation == "safe-lock", "{outcome:?}");
            assert_eq!(
                credentials::read(&origin).unwrap().unwrap().bearer(),
                "marfa_at_old"
            );
            assert_eq!(
                credentials::current().unwrap().as_deref(),
                Some(origin.as_str())
            );
        }
        "present" => assert_eq!(
            credentials::read(&origin).unwrap().unwrap().bearer(),
            "marfa_at_new"
        ),
        "absent" => {
            assert!(credentials::read(&origin).unwrap().is_none());
            assert!(credentials::current().unwrap().is_none());
        }
        other => panic!("unknown fixture operation: {other}"),
    }
}

struct Process(Option<Child>);

impl Process {
    fn finish(mut self) -> std::process::Output {
        let child = self.0.as_mut().unwrap();
        let started = Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(
                started.elapsed() < BUDGET,
                "credential process did not finish"
            );
            sleep(Duration::from_millis(10));
        }
        let output = self.0.take().unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Fixture {
    folder: PathBuf,
    origin: String,
}

impl Fixture {
    fn new(origin: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let folder = std::env::temp_dir().join(format!(
            "marfa-credential-process-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(folder.join("store")).unwrap();
        let fixture = Self {
            folder,
            origin: origin.into(),
        };
        fixture.spawn("seed", "seed").finish();
        fixture
    }

    fn spawn(&self, operation: &str, name: &str) -> Process {
        let environment = self.folder.join(name);
        std::fs::create_dir_all(&environment).unwrap();
        let ready = environment.join("ready");
        let process = Process(Some(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "auth::process_tests::credential_process_child",
                    "--nocapture",
                ])
                .env_remove("MARFA_API_KEY")
                .env_remove("MARFA_API_URL")
                .env("MARFA_TEST_CREDENTIAL_OPERATION", operation)
                .env("MARFA_TEST_CREDENTIAL_STORE", self.folder.join("store"))
                .env("MARFA_TEST_ORIGIN", &self.origin)
                .env("MARFA_TEST_READY", &ready)
                .env("TMPDIR", &environment)
                .env("XDG_RUNTIME_DIR", &environment)
                .env("HOME", &environment)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let started = Instant::now();
        while !ready.exists() {
            assert!(
                started.elapsed() < BUDGET,
                "child never reached credential operation"
            );
            sleep(Duration::from_millis(10));
        }
        process
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

struct Server {
    origin: String,
    requests: mpsc::Receiver<(String, String)>,
    gate: Arc<(Mutex<bool>, Condvar)>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(held_path: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (sent, requests) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let held = gate.clone();
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut workers = Vec::new();
            while !stopping.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let sent = sent.clone();
                        let held = held.clone();
                        workers.push(std::thread::spawn(move || {
                            respond(stream, held_path, held, sent)
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            origin,
            requests,
            gate,
            stop,
            thread: Some(thread),
        }
    }

    fn entered(&self, path: &str) -> String {
        loop {
            let (found, body) = self
                .requests
                .recv_timeout(BUDGET)
                .expect("expected HTTP request");
            if found == path {
                return body;
            }
            assert_eq!(found, "/");
        }
    }

    fn release(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.release();
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn respond(
    mut stream: TcpStream,
    held_path: &str,
    gate: Arc<(Mutex<bool>, Condvar)>,
    sent: mpsc::Sender<(String, String)>,
) {
    // On macOS, accepted sockets inherit the listener's nonblocking mode.
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(BUDGET)).unwrap();
    let mut request = Vec::new();
    let mut byte = [0];
    while !request.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        request.push(byte[0]);
    }
    let head = String::from_utf8(request).unwrap();
    let path = head.split_whitespace().nth(1).unwrap();
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    sent.send((path.into(), String::from_utf8(body).unwrap()))
        .unwrap();
    if path == held_path {
        let (released, timed) = gate
            .1
            .wait_timeout_while(gate.0.lock().unwrap(), BUDGET, |released| !*released)
            .unwrap();
        assert!(
            *released && !timed.timed_out(),
            "HTTP response was not released"
        );
    }
    let body = match path {
        "/" => format!(r#"{{"name":"marfa","contract":{}}}"#, marfa_client::CONTRACT_VERSION),
        "/token" => r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#.into(),
        "/revoke" => "{}".into(),
        _ => panic!("unexpected path {path}"),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Marfa-Contract: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        marfa_client::CONTRACT_VERSION,
        body.len(),
        body
    );
}

#[test]
fn refresh_processes_with_different_environments_rotate_once() {
    for (first_operation, second_operation) in [
        ("refresh", "refresh"),
        ("refresh", "refused"),
        ("resolve-refresh", "resolve-refresh"),
    ] {
        let server = Server::new("/token");
        let fixture = Fixture::new(&server.origin);
        let first = fixture.spawn(first_operation, "one");
        assert!(
            server
                .entered("/token")
                .contains("refresh_token=marfa_rt_old")
        );
        let second = fixture.spawn(second_operation, "two");
        let extra = server.requests.recv_timeout(Duration::from_millis(400));
        server.release();
        first.finish();
        second.finish();
        assert!(
            matches!(extra, Err(mpsc::RecvTimeoutError::Timeout)),
            "second process reached HTTP while refresh was held: {extra:?}"
        );
        assert!(
            matches!(server.requests.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "token rotated more than once"
        );
        fixture.spawn("present", "read").finish();
    }
}

#[test]
fn credential_removal_waits_for_refresh_and_cannot_be_undone_by_it() {
    for operation in ["logout", "forget"] {
        let server = Server::new("/token");
        let fixture = Fixture::new(&server.origin);
        let refresh = fixture.spawn("refresh", "one");
        server.entered("/token");
        let mut removal = fixture.spawn(operation, "two");
        sleep(Duration::from_millis(400));
        let finished_early = removal.0.as_mut().unwrap().try_wait().unwrap().is_some();
        server.release();
        refresh.finish();
        removal.finish();
        assert!(
            !finished_early,
            "{operation} finished during a refresh and could be undone by it"
        );
        if operation == "logout" {
            assert!(server.entered("/revoke").contains("token=marfa_rt_new"));
        }
        fixture.spawn("absent", "read").finish();
    }
}

#[test]
fn refresh_waits_for_logout_then_observes_the_removed_credential() {
    let server = Server::new("/revoke");
    let fixture = Fixture::new(&server.origin);
    let logout = fixture.spawn("logout", "one");
    assert!(server.entered("/revoke").contains("token=marfa_rt_old"));
    let refresh = fixture.spawn("signed-out", "two");
    let extra = server.requests.recv_timeout(Duration::from_millis(400));
    server.release();
    logout.finish();
    refresh.finish();
    assert!(
        matches!(extra, Err(mpsc::RecvTimeoutError::Timeout)),
        "refresh reached HTTP during logout: {extra:?}"
    );
    fixture.spawn("absent", "read").finish();
}

#[test]
fn local_forgetting_needs_no_refresh_or_network_for_expired_tokens() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    for origin in [&origin, &format!("{origin}/api")] {
        for operation in ["forget", "forget-current"] {
            let fixture = Fixture::new(origin);
            fixture.spawn(operation, "remove").finish();
            fixture.spawn("absent", "read").finish();
        }
    }
}

#[test]
fn credential_lock_rejects_insecure_paths_before_touching_credentials() {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink};
    let fixture = Fixture::new("http://127.0.0.1:9");
    let dir = fixture.folder.join("locks");
    fixture.spawn("safe-lock", "witness").finish();
    let path = dir.join(format!("{}.lock", fingerprint(&fixture.origin)));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    fixture.spawn("unsafe-lock", "directory-mode").finish();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    fixture.spawn("unsafe-lock", "file-mode").finish();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let target = fixture.folder.join("other-file");
    std::fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    fixture.spawn("unsafe-lock", "file-link").finish();
    std::fs::remove_file(&path).unwrap();
    std::fs::hard_link(&target, &path).unwrap();
    fixture.spawn("unsafe-lock", "hard-link").finish();
    std::fs::remove_file(&path).unwrap();
    let fifo = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // The path is a NUL-terminated fixture path and mkfifo retains no pointer.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    fixture.spawn("unsafe-lock", "fifo").finish();
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_dir(&dir).unwrap();
    let other = fixture.folder.join("other-directory");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&other)
        .unwrap();
    symlink(&other, &dir).unwrap();
    fixture.spawn("unsafe-lock", "directory-link").finish();
    assert!(!other.join(path.file_name().unwrap()).exists());
    std::fs::remove_file(&dir).unwrap();
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&dir)
        .unwrap();
    fixture.spawn("unsafe-lock", "not-directory").finish();
}

#[test]
fn credential_lock_fingerprint_is_stable() {
    assert_eq!(
        fingerprint(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        fingerprint("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn resolution_checks_the_lock_before_reading_even_a_fresh_credential() {
    use std::os::unix::fs::PermissionsExt;
    let origin = format!(
        "https://resolve-{}-{}.invalid",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let fixture = Fixture::new(&origin);
    drop(credential_lock_file(&origin).unwrap());
    let path = user_home()
        .unwrap()
        .join(".marfa-credential-locks")
        .join(format!("{}.lock", fingerprint(&origin)));
    struct RestoreMode(PathBuf);
    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = RestoreMode(path.clone());
    fixture.spawn("seed-fresh", "fresh").finish();
    fixture.spawn("resolve", "safe-fresh").finish();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let account: String = origin.bytes().map(|byte| format!("{byte:02x}")).collect();
    std::fs::write(
        fixture.folder.join("store").join(account),
        "not a credential",
    )
    .unwrap();
    fixture.spawn("resolve-unsafe", "unsafe-corrupt").finish();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    fixture.spawn("resolve-corrupt", "safe-corrupt").finish();
    fixture.spawn("seed-fresh", "replace-fresh").finish();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    fixture.spawn("resolve-unsafe", "unsafe-fresh").finish();
}

#[test]
fn logout_without_a_revocation_endpoint_does_not_claim_revocation() {
    for operation in ["logout", "logout-human"] {
        let fixture = Fixture::new("http://127.0.0.1:9");
        fixture.spawn("seed-no-revoke", "replace").finish();
        let output = fixture.spawn(operation, "remove").finish();
        let printed = String::from_utf8(output.stdout).unwrap();
        if operation == "logout" {
            assert!(printed.contains("\"revoked\": false"), "{printed}");
        } else {
            assert!(printed.contains("no revocation endpoint"), "{printed}");
        }
        fixture.spawn("absent", "read").finish();
    }
}
