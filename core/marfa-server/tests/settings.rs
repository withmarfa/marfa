//! The settings as a real process meets them: its log, files and restarts.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use marfa_server::app::App;
use marfa_server::app::refusal::Code;
use marfa_server::app::stored::{self, Change};
use marfa_server::db::Write as DbWrite;
use marfa_server::settings::registry::{MAX_REQUEST_BYTES, SIGN_IN_ADDRESS};
use marfa_server::settings::{Environment, Settings};
use rusqlite::Connection;
use serde_json::Value;
use tempfile::TempDir;

const CHANGE: DbWrite = DbWrite::caller("settings.change");
const STALE_VALUE: &str = "stale-value-from-a-shell";
const MINT: &str = r#"{"label":"proof","source":"proof","permissions":["keys.mint"]}"#;

/// The socket's folders must hold no symbolic link, as macOS's temporary
/// folder does.
fn control_socket(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap().join("control").join("s.sock")
}

fn program(dir: &Path, hooks: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa-server"));
    command
        .env_clear()
        .env("PORT", "0")
        .env("MARFA_LISTEN_HOST", "127.0.0.1")
        .env("MARFA_TEST_HOOKS", hooks)
        .env("SQLITE_PATH", dir.join("marfa.db"))
        .env("BLOB_PATH", dir.join("blobs"))
        .env("MARFA_CONTROL_SOCKET", control_socket(dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

struct Server {
    child: Child,
    port: u16,
    seen: Vec<String>,
    log: mpsc::Receiver<String>,
}

impl Server {
    fn start(mut command: Command) -> Server {
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (lines, log) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = lines.send(line);
            }
        });
        let mut server = Server {
            child,
            port: 0,
            seen: Vec::new(),
            log,
        };
        while server.port == 0 {
            let line = server.log.recv_timeout(Duration::from_secs(20)).unwrap();
            if let Some((_, rest)) = line.split_once("listening on port ") {
                let digits = rest.chars().take_while(char::is_ascii_digit);
                server.port = digits.collect::<String>().parse().unwrap();
            }
            server.seen.push(line);
        }
        server
    }

    fn stop(mut self) -> String {
        let pid = self.child.id().to_string();
        assert!(Command::new("kill").arg(&pid).status().unwrap().success());
        assert_eq!(self.child.wait().unwrap().code(), Some(0));
        self.seen.extend(self.log.iter());
        self.seen.join("\n")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn exchange(
    mut stream: impl Read + Write,
    method: &str,
    path: &str,
    head: &str,
    body: &str,
) -> String {
    let length = body.len();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{head}\
         Content-Type: application/json\r\nContent-Length: {length}\r\n\r\n{body}"
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer
}

fn status(answer: &str) -> u16 {
    answer.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn body(answer: &str) -> Value {
    serde_json::from_str(answer.split_once("\r\n\r\n").unwrap().1).unwrap()
}

fn mint(dir: &Path) -> String {
    let control = UnixStream::connect(dir.join("control").join("s.sock")).unwrap();
    let answer = exchange(control, "POST", "/keys", "", MINT);
    assert_eq!(status(&answer), 201, "{answer}");
    body(&answer)["key"].as_str().unwrap().to_string()
}

fn key_works(server: &Server, key: &str) -> bool {
    let public = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    let head = format!("Authorization: Bearer {key}\r\n");
    status(&exchange(public, "GET", "/keys", &head, "")) == 200
}

fn everything_on_stdout(dir: &Path, mut command: Command) -> (Option<i32>, String) {
    let output = command.output().unwrap();
    assert!(!dir.join("marfa.db").exists());
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

#[test]
fn the_setup_code_is_logged_at_the_level_every_warning_uses() {
    let dir = TempDir::new().unwrap();
    let log = Server::start(program(dir.path(), "false")).stop();
    let line = log
        .lines()
        .find(|line| line.contains("setup code"))
        .unwrap();
    assert!(line.contains("\"level\":\"warn\""), "{line}");
}

#[test]
fn a_stale_shell_is_ignored_and_warned_of_by_name_alone() {
    let dir = TempDir::new().unwrap();
    let mut command = program(dir.path(), "false");
    command
        .env("MARFA_MAX_REQUEST_BYTES", STALE_VALUE)
        .env("RATE_LIMIT_ENABLED", STALE_VALUE)
        .env("MARFA_AUTH_BASE_URL", STALE_VALUE)
        .env("NODE_ENV", "production");
    let log = Server::start(command).stop();

    let warnings: Vec<_> = log
        .lines()
        .filter(|line| line.contains("\"level\":\"warn\""))
        .collect();
    for (name, key) in [
        ("MARFA_MAX_REQUEST_BYTES", "max_request_bytes"),
        ("RATE_LIMIT_ENABLED", "rate_limit_enabled"),
        ("MARFA_AUTH_BASE_URL", "sign_in_address"),
    ] {
        let found = warnings.iter().filter(|line| line.contains(name));
        let found: Vec<_> = found.filter(|line| line.contains(key)).collect();
        assert_eq!(found.len(), 1, "{name}: {log}");
        assert!(found[0].contains("/config"), "{log}");
    }
    assert!(!log.contains("NODE_ENV"), "{log}");
    assert!(!log.contains(STALE_VALUE), "{log}");
}

#[test]
fn a_refused_start_makes_no_secrets_file() {
    let dir = TempDir::new().unwrap();
    let mut command = program(dir.path(), "false");
    command.env("PORT", "seventy");
    let (code, _) = everything_on_stdout(dir.path(), command);
    assert_eq!(code, Some(1));
    assert!(!dir.path().join("marfa.secrets").exists());
}

#[test]
fn a_socket_it_cannot_claim_stops_it_before_any_secret_is_made() {
    let dir = TempDir::new().unwrap();
    let control = dir.path().join("control");
    std::fs::create_dir(&control).unwrap();
    std::fs::set_permissions(&control, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(control.join("s.sock"), "not a socket").unwrap();
    let (code, log) = everything_on_stdout(dir.path(), program(dir.path(), "false"));
    assert_eq!(code, Some(1));
    assert!(log.contains("Control socket already exists"), "{log}");
    assert!(!dir.path().join("marfa.secrets").exists());
}

#[test]
fn a_generated_salt_keeps_a_key_working_across_a_restart_and_never_reaches_the_log() {
    let dir = TempDir::new().unwrap();
    let server = Server::start(program(dir.path(), "false"));
    let key = mint(dir.path());
    assert!(key_works(&server, &key));
    let first = server.stop();

    let written = std::fs::read_to_string(dir.path().join("marfa.secrets")).unwrap();
    let values = written.lines().filter_map(|line| line.split_once('='));
    let values: Vec<_> = values.map(|(_, value)| value.to_string()).collect();
    assert_eq!(values.len(), 2);

    let server = Server::start(program(dir.path(), "false"));
    assert!(key_works(&server, &key));
    let second = server.stop();
    for value in values {
        assert!(!first.contains(&value) && !second.contains(&value));
    }
}

#[test]
fn a_row_that_does_not_read_keeps_the_server_up_and_stays() {
    let dir = TempDir::new().unwrap();
    Server::start(program(dir.path(), "true")).stop();
    let database = dir.path().join("marfa.db");
    let put = "INSERT INTO settings (key, value) VALUES ('max_request_bytes', 'a lot')";
    Connection::open(&database)
        .unwrap()
        .execute(put, [])
        .unwrap();

    let server = Server::start(program(dir.path(), "true"));
    let public = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    assert_eq!(status(&exchange(public, "GET", "/", "", "")), 200);
    let log = server.stop();
    let errors = log
        .lines()
        .filter(|line| line.contains("\"level\":\"error\""));
    assert_eq!(
        errors
            .filter(|line| line.contains("max_request_bytes"))
            .count(),
        1,
        "{log}"
    );

    let read = "SELECT value FROM settings WHERE key = 'max_request_bytes'";
    let kept: String = Connection::open(&database)
        .unwrap()
        .query_row(read, [], |row| row.get(0))
        .unwrap();
    assert_eq!(kept, "a lot");
}

#[tokio::test]
async fn the_sign_in_address_follows_the_port_bound_until_one_is_stored() {
    let dir = TempDir::new().unwrap();
    let database = dir.path().join("marfa.db");
    let pairs = [
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", dir.path().to_str().unwrap()),
        ("MARFA_LISTEN_HOST", "127.0.0.1"),
        ("PORT", "0"),
    ];
    let accepted = Settings::read(Environment::from_pairs(&pairs)).unwrap();
    let app = App::start(accepted).await.unwrap();
    assert_eq!(app.addresses().sign_in().origin(), "http://127.0.0.1:0");
    app.record_bound_port(51234);
    let sign_in = app.addresses().sign_in();
    assert_eq!(sign_in.origin(), "http://127.0.0.1:51234");
    assert_eq!(sign_in.port(), 51234);
    app.db.close().await;
}

struct Instance {
    dir: TempDir,
    app: Arc<App>,
}

async fn boot(dir: &Path) -> Arc<App> {
    let database = dir.join("marfa.db");
    let pairs = [
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", dir.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("MARFA_MAX_REQUEST_BYTES", "4096"),
    ];
    let accepted = Settings::read(Environment::from_pairs(&pairs)).unwrap();
    App::start(accepted).await.unwrap()
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let app = boot(dir.path()).await;
        Instance { dir, app }
    }

    fn row(&self, key: &str) -> Option<String> {
        let read = "SELECT value FROM settings WHERE key = ?1";
        Connection::open(self.dir.path().join("marfa.db"))
            .unwrap()
            .query_row(read, [key], |row| row.get(0))
            .ok()
    }

    fn limit(&self) -> u64 {
        self.app.settings.live().get(MAX_REQUEST_BYTES)
    }
}

fn set(key: &str, value: impl ToString) -> Change {
    Change {
        key: key.to_string(),
        value: Some(value.to_string()),
    }
}

fn clear(key: &str) -> Change {
    Change {
        key: key.to_string(),
        value: None,
    }
}

#[tokio::test]
async fn a_change_is_live_at_once_survives_a_restart_and_clears_to_the_seed() {
    let mut instance = Instance::start().await;
    assert_eq!(instance.limit(), 4096);

    let changed = vec![set("max_request_bytes", 2048)];
    stored::change(&instance.app, CHANGE, changed)
        .await
        .unwrap();
    assert_eq!(instance.limit(), 2048);

    instance.app.db.close().await;
    instance.app = boot(instance.dir.path()).await;
    assert_eq!(instance.limit(), 2048);

    let cleared = vec![clear("max_request_bytes")];
    stored::change(&instance.app, CHANGE, cleared)
        .await
        .unwrap();
    assert_eq!(instance.limit(), 4096);
    assert_eq!(instance.row("max_request_bytes"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn racing_changes_leave_the_snapshot_at_the_last_commit() {
    let instance = Instance::start().await;
    for round in 0..1000u64 {
        let changes = (1..=8u64).map(|n| {
            let app = instance.app.clone();
            tokio::spawn(async move {
                let value = round * 100 + n;
                let change = vec![set("max_request_bytes", value)];
                stored::change(&app, CHANGE, change).await.unwrap();
            })
        });
        for change in changes.collect::<Vec<_>>() {
            change.await.unwrap();
        }
        let committed = instance.row("max_request_bytes").unwrap();
        assert_eq!(instance.limit().to_string(), committed);
    }
}

#[tokio::test]
async fn a_failed_commit_publishes_nothing_and_the_next_change_lands() {
    let instance = Instance::start().await;
    let first = vec![set("max_request_bytes", 2048)];
    stored::change(&instance.app, CHANGE, first).await.unwrap();

    let faults = &instance.app.faults;
    faults.set("fail:commit", Some("settings.change")).unwrap();
    let doomed = vec![set("max_request_bytes", 1024)];
    assert!(stored::change(&instance.app, CHANGE, doomed).await.is_err());
    assert_eq!(faults.list()[0].fired, 1);
    assert_eq!(instance.limit(), 2048);
    assert_eq!(instance.row("max_request_bytes").unwrap(), "2048");

    faults.clear(None);
    let next = vec![set("max_request_bytes", 512)];
    stored::change(&instance.app, CHANGE, next).await.unwrap();
    assert_eq!(instance.limit(), 512);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_still_publishes_when_its_caller_goes_away() {
    let instance = Instance::start().await;
    let faults = instance.app.faults.clone();
    faults.set("hold:write", Some("settings.change")).unwrap();

    let app = instance.app.clone();
    let caller = tokio::spawn(async move {
        let change = vec![set("max_request_bytes", 2048)];
        let _ = stored::change(&app, CHANGE, change).await;
    });
    while faults.list().iter().all(|fault| fault.waiting == 0) {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    caller.abort();
    let _ = caller.await;
    faults.clear(None);

    for _ in 0..500 {
        if instance.limit() == 2048 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("the change committed but never went live");
}

#[tokio::test]
async fn a_refused_change_writes_nothing_of_itself() {
    let instance = Instance::start().await;
    for doomed in [
        set("max_request_bytes", 0),
        set("sign_in_address", "marfa.example"),
        set("no_such_setting", 1),
        set("health_probe", "a note is not a setting"),
    ] {
        let key = doomed.key.clone();
        let changes = vec![set("rate_limit_window_ms", 1000), doomed];
        let refusal = stored::change(&instance.app, CHANGE, changes)
            .await
            .unwrap_err();
        assert_eq!(refusal.code, Code::ValidationError);
        assert!(refusal.message.contains(&key), "{}", refusal.message);
        assert_eq!(instance.row("rate_limit_window_ms"), None);
    }
}

#[tokio::test]
async fn a_row_holds_the_normalized_address_and_a_blank_clears_it() {
    let instance = Instance::start().await;
    let live = |instance: &Instance| instance.app.settings.live().get(SIGN_IN_ADDRESS);

    let tidy = vec![set("sign_in_address", "HTTPS://Marfa.Example:443/")];
    stored::change(&instance.app, CHANGE, tidy).await.unwrap();
    assert_eq!(
        instance.row("sign_in_address").unwrap(),
        "https://marfa.example"
    );
    assert_eq!(live(&instance).unwrap().origin(), "https://marfa.example");
    assert_eq!(instance.app.addresses().sign_in().host(), "marfa.example");

    let blank = vec![set("sign_in_address", "")];
    stored::change(&instance.app, CHANGE, blank).await.unwrap();
    assert_eq!(instance.row("sign_in_address"), None);
    assert_eq!(live(&instance), None);
}

#[tokio::test]
async fn a_change_mends_a_row_that_does_not_read() {
    let instance = Instance::start().await;
    instance.app.db.close().await;
    let database = instance.dir.path().join("marfa.db");
    let put = "INSERT INTO settings (key, value) VALUES ('max_request_bytes', 'a lot')";
    Connection::open(&database)
        .unwrap()
        .execute(put, [])
        .unwrap();

    let app = boot(instance.dir.path()).await;
    assert_eq!(app.settings.live().unreadable(), ["max_request_bytes"]);
    assert_eq!(app.settings.live().get(MAX_REQUEST_BYTES), 4096);

    let mended = vec![set("max_request_bytes", 2048)];
    stored::change(&app, CHANGE, mended).await.unwrap();
    assert!(app.settings.live().unreadable().is_empty());
    assert_eq!(app.settings.live().get(MAX_REQUEST_BYTES), 2048);
}
